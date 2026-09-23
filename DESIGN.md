# LOIS — design notes

## Why build our own (not YADDA)

YADDA (github.com/chacon-sec/YADDA) proved the concept and documents the wire
protocol well, but: it is AI-written and self-declared unreviewed, its trust
chain (npm deps incl. javascript-obfuscator) is unaudited, and it carries GPL
port-marks from Adaptix beacon code. LOIS re-ports the protocol from the
canonical sources in our own tree (`AdaptixC2-v2.0/AdaptixServer/extenders/
beacon_agent/src_beacon/beacon/{Packer,Agent,Commander,WaitMask,Downloader}.cpp`,
`beacon_listener_http/pl_transport.go`), keeping zero runtime dependencies and
a hand-rolled, deterministic, auditable bundler. YADDA reads as a design
reference only; no YADDA code is imported.

## Wire protocol (verified against canonical sources 2026-09-23)

- Beat: `base64(RC4(encrypt_key[16], beatPlain))` in the hb header
  (`ParameterName`, listener config). beatPlain = BE packer fields per
  `Agent::BuildBeat` — note the `internal_ip` byte-swap quirk (inet_addr
  host-order DWORD packed BE) and `flag = is_server|elevated|sys64|arch64`
  shift chain. agentUid server-side = BE u32 agent_id.
- Tasks: server→agent LE (`pl_packer.go` PackArray): u32le total (excludes
  itself), per task u32le cmd | args | u32le taskId (TRAILING). Agent→server
  BE: u32be total (INCLUDES itself — MainAgent `Set32(0, datasize())`), then
  `[taskId][cmd][fields]*`.
- Response envelope: listener splices `RC4(session_key, taskStream)` RAW where
  `<<<PAYLOAD_DATA>>>` sits in `WebPageOutput`. Agent config carries
  `resp_template` (split into pre/post at load). Strings inside the template
  must round-trip latin1 (binary-safe).
- Session key: random 16B per run; the server learns it at registration ONLY
  (`TsAgentCreate`). Fixed agent_id builds must persist one key (sidecar).
- Sleep/jitter: `WaitMask.cpp` — delta = rand % (sleep*jitter/100) subtracted
  from sleep*1000 (upstream seconds-vs-ms quirk preserved deliberately).
- Command IDs: `Commander.h`. Implemented v0.1: 4/8/14/15/17/21/22/23/24/27/
  32/33/35/41/42 + 10. Downloads pump one chunk per tick (Downloader.cpp).
- `default: break` behavior for unknown commands is shared with the C++
  beacon — unknown arg-bearing commands desync both implants identically;
  the stock server never sends us any.

## Electron delivery (per the Maldev electron-persistence module)

- Fuses decide the path: `EnableEmbeddedAsarIntegrityValidation` OFF → repack
  (`inject_asar.js`, hook = one guarded line appended to package.json's main
  entry, payload + sidecar OUTSIDE the archive). ON (Discord/Slack) →
  `inject_unpacked.js` appends a guarded main-process-only line to
  `resources/app.asar.unpacked/node_modules/bindings/bindings.js` (no
  integrity coverage there), payload in `resources/`.
- Host-never-notices contract: no throws at load, no console output (dev logs
  stripped at build, not just silenced), no lifecycle/window/dock mutation,
  defer to `app.whenReady()`.
- Airlock note: the default build loads NOTHING native. A future COFF addon
  (.node) is an unsigned-DLL load — Airlock blocks it — so it stays an
  opt-in, non-Airlock module.

## Hygiene pipeline (build_payload.js)

comment strip → log-line strip → per-build token rename (`--fixed-tokens` for
tests/dev) → optional esbuild minify → denylist gate. Denylist failure =
failed build. The `<<<PAYLOAD_DATA>>>` marker is protocol-required and exempt.

## NaX HTTP channel (src/nhttp.js, ticket 014)

Second transport, selected by `"transport": "nax"` in the bake. Wire summary
(canonical: NaX/src_server/listener_nonameax_http + agent_nonameax):

- All integers little-endian. Frame = type(1)|flags(1)|bodylen(u32)|body;
  envelope = IV(16)||AES-128-CBC-PKCS7(frame, encrypt_key). No per-session key.
- REGISTER (0x01, lp16 identity fields) POSTed RAW to post_uris[0]
  (pre-profile fallback); server answers a PROFILE (0x82) frame — full v2
  profile (URIs/UA/headers/encodings/rotation), parsed and applied. Hosts from
  the profile are deliberately NOT adopted (baked redirector hosts win).
- Steady state: HEARTBEAT (0x02, empty body) GET, envelope transformed per
  get.client_meta (format raw/b64/b64url/hex, 4-byte XOR mask, placement
  body/header/cookie/parameter, prepend/append). Tasks: TASK (0x81) frames in
  the GET reply; NO_TASKS (0x80) ends the walk; verbatim EmptyResp also
  accepted (the Go parser drops `empty_response` keys — then NO_TASKS arrives
  encrypted instead; both handled).
- Results: one RESULT (0x03) frame per task, POSTed per post.client_output
  (body placement). **Post.ClientMeta carries only the 16-char session id,
  never the envelope** (ignored server-side).
- Beacon id = 8 random bytes hex (16 ascii) in the beacon-id header
  (default X-Correlation-Id; bake `hb_header`).
- Command layer: NaX cmd ids (whoami 0x10 ... profile 0x30), structured
  LS/PS_LIST formats, chunked DOWNLOAD (start/continue/finish),
  SAVEMEMORY+UPLOAD two-phase push. Unknown commands no-op silently.
- Cadence: NaxSleep = sleep_ms ± jitter% uniform; immediate re-poll while
  results/downloads are pending (C parity).
