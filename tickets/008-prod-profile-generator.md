# 008: Production listener profile pack generator

**Layer:** C2 profile/infra · **Status:** open · **Priority:** P1 · **Depends on:** —

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
