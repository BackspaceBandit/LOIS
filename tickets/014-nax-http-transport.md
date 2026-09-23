# 014: NaX HTTP channel transport (opsec upgrade over stock BeaconHTTP)

**Layer:** transport · **Status:** done 2026-09-24 (suite 20/20 incl. mock
round-trip; live e2e vs `testhttp2` jquery profile from a local agent AND
from DT-MDE-TEST (agent 18, Code.exe) — register + pwd/ls, MDE clean) · **Priority:** P1 for real ops
(not needed for CS-lab validation) · **Depends on:** 001, 002

## Outcome notes
- `src/nhttp.js` implements the full NaX HTTP channel from the canonical
  spec: AES-128-CBC envelopes (IV||CT), frame layer, REGISTER (pre-profile
  fallback POST) + PROFILE v2 parse/apply, HEARTBEAT GET with full OutputConfig
  transform engine (raw/base64/base64url/hex, XOR mask, body/header/cookie/
  parameter placements, prepend/append, empty_resp), RESULT POSTs, LE
  command set (whoami/sleep/cd/pwd/mkdir/rmdir/cat/ls-structured/cp/mv/
  ps_list-structured/ps_kill/download-chunked/savememory+upload/profile/
  exit), NaxSleep cadence, immediate re-poll while work is pending.
- Selection: `transport: "nax"` in the bake (or `LOIS_TRANSPORT` env);
  stock transport untouched.
- Two wire subtleties honored: Post.ClientMeta carries ONLY the 16-char
  session id (never the envelope — putting it there makes Node reject the
  binary header value); hosts from the profile frame are deliberately NOT
  adopted (baked redirector hosts stay authoritative, C parity).
- Deferred within-ticket: recursive LS tree mode (flags&1 → clean error),
  tunnels over NaX (0x3E–0x46), BOF/screenshot/shell commands.
- testhttp2's jquery profile exercised the hard paths live: mask+base64 in
  cookie __cfduid, prepend/append, URI rotation, dropped empty_response →
  encrypted NO_TASKS.

## Why
Stock `beacon_listener_http` is a fixed-shape channel: one POST URI, one
template, RC4-only, no rotation — regularity an NDR/EDR baseline catches
before content matters. Our NaX HTTP listener (NoNameAx) already has the
malleable surface we want: GET/POST URI rotation, metadata placement
(cookie/header/body/param), mask byte, base64/base64url, custom headers,
prepend/append padding (jquery-style), server-error profile, per-callback
UA — and it matches the infra we already run in prod (nginx GUID gate → WG
tunnel → NaX listener).

## Goal
Add a second transport to LOIS: `src/transport/naxhttp.js` alongside the
stock one, selected at bake time (`"transport": "naxhttp"`). Stock transport
stays (lab/compat).

## Scope
- Port the NaX wire semantics from the canonical sources:
  `~/Desktop/NaX-custom/NaX/src_server/listener_nonameax_http` (Go) for the
  server side and the NaX agent's HTTP connector (C) for client behavior:
  beat/metadata packing, placement encode/decode (cookie/header/param/body,
  mask, b64 variants, prepend/append strip), task fetch + result post split,
  rotation policy (sequential/random), error-page handling.
- Config schema mirrors the NaX listener profile 1:1 so `gen_profile.js`
  (008) can emit both sides of the channel from one op file.
- Watermark stays our patched value; hb header naming follows the NaX
  profile's `beacon_id_header` (never the signatured default).
- Keep it pure JS / zero-dep; same crash-containment rules as 003.

## Files
- create: `src/transport/naxhttp.js`, `test/mock_nax_listener.js`
- modify: `src/agent.js` (transport switch), `src/config.js`,
  `scripts/build_payload.js`, `test/run_tests.js`, `README.md`, `DESIGN.md`

## Acceptance
- Mock round-trip suite green for the naxhttp transport (register, task,
  result, rotation, mask on/off, cookie+body placements).
- Live e2e vs `testhttp2` (NaX listener, jquery profile) on AdaptixTest:
  register + pwd/ls/mkdir with console output, MDE gate clean on
  DT-MDE-TEST.
- DESIGN.md gains a wire-format section for the NaX channel (same rigor as
  the stock one).
