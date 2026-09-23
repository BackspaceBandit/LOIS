# 009: Residual network-risk documentation

**Layer:** docs/opsec · **Status:** open · **Priority:** P3 · **Depends on:** 008

## Goal
Write down the risk we CANNOT engineer away so it's a conscious decision:
an Electron host (e.g. Discord.exe) POSTing on a cadence to a domain it has
no business with is a network anomaly no profile fully hides. Falcon/NDR
attribute connections per-process; per-process netflow from Discord.exe to
`our-domain` is the residual signature.

## Scope
- `docs/opsec.md` section covering: mitigations in place (aged domain, valid
  cert, plausible category/content, GUID-gated path, low cadence + real
  jitter, host-matched UA), what remains (process→domain mismatch, cadence
  regularity under long observation), and the explicit trade-offs.
- Note the escape hatch without building it: upstream `beacon_listener_dns`
  exists; DNS-over-HTTPS-style channels would change the signature class
  entirely. Out of scope until needed — document only.
- Include the "operator mistakes that burn us" list: plain HTTP to a public
  IP, default template, 5 s sleep in prod, debug builds on target.

## Files
- create: `docs/opsec.md` (or section in `docs/deploy.md`)

## Acceptance
- Reviewed by the operator before first prod deploy; linked from README.
