# 008: Production listener profile pack generator

**Layer:** C2 profile/infra · **Status:** done 2026-09-23 (generated pack
validated live vs AdaptixTest: listener create → register → pwd round-trip;
URI gating + 404 error page verified) · **Priority:** P1 · **Depends on:** —

## Outcome notes
- `scripts/gen_profile.js` renders listener.json + bake.json +
  nginx-location.conf + NOTES.md from one op file; enforces prod minimums
  (sleep>=60, jitter>=20, no signatured hb header) unless `"lab": true`.
- Generated packs land in `ops/<name>/` and are gitignored (they contain
  keys); `ops/example.json` is the committed template.
- Validated with lab pack `labtest2` (listener `loistest2`, :8446, URI
  /api/v2/telemetry): agent 15 registered + pwd round-trip OK; wrong-URI
  and bad-beat requests get the 404 profile page. loistest2 stopped after
  validation.
- Known limitation recorded: LOIS uses bake `uri[0]` only (no multi-URI
  rotation agent-side yet).

## Goal
Lab profile (plain HTTP, `/content.html`, 5 s sleep) must never reach prod.
One command should render a complete, consistent prod profile: listener
config + LOIS bake config + redirector nginx snippet, all from one op file.

## Design
- `scripts/gen_profile.js --op ops/<name>.json` → outputs:
  - BeaconHTTP listener JSON (UA list, POST/GET URIs, hb header, response
    template, error page matching the fake-site theme, fresh encrypt_key);
  - LOIS bake JSON (matching values, sleep ≥60 s, jitter ≥30 %);
  - nginx `location ^~ /<guid>/` block for the redirector (existing
    notehosting/crucialness model: GUID gate → WG tunnel → teamserver).
- Prod rules enforced by the generator: `ssl: true` through redirector only
  (listener itself stays plain-HTTP on the WG interface), no default UA/URI/
  template values, watermark stays our patched `0x5f3a91c2`.
- Deploy steps documented: `docs/deploy.md`.

## Files
- create: `scripts/gen_profile.js`, `ops/example.json`, `docs/deploy.md`

## Acceptance
- Generated profile deployed to AdaptixTest `loistest2`: LOIS built with the
  generated bake registers + tasks round-trip through the GUID-gated nginx
  path; ungated path returns the 404 profile; MDE regression gate clean.
