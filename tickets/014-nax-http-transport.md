# 014: NaX HTTP channel transport (opsec upgrade over stock BeaconHTTP)

**Layer:** transport · **Status:** open · **Priority:** P1 for real ops
(not needed for CS-lab validation) · **Depends on:** 001, 002

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
