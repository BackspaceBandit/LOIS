# 018: node_agent-style teamserver extender (server-side payload generation)

**Layer:** integration · **Status:** SKIPPED 2026-09-24 (operator decision — not needed for the current op set) · **Priority:** P3 · **Depends on:** 004, 008, 012

## Why
Today a LOIS payload is built locally (`build_payload.js`) and injected by
hand. A teamserver extender (our own agent module, e.g. watermark
`LOIS`-class) would let operators generate configured payloads straight from
the Adaptix client/REST — same ergonomics as NaX beacon generation — with
the tested-config stamp (012) visible at generation time.

## Scope
- `extender/`: Go plugin (agent type) wrapping the LOIS build pipeline:
  generation = render config → bundle (shell out to node build_payload on
  the teamserver host — document the node dependency, or prebuild a set of
  base bundles and patch config only).
- Register against `beacon_listener_http` first; NaX channel variant after
  014 lands.
- GUI/REST: agent appears in Generate dialog; config fields = the bake
  schema; output = `support.js`-class artifact + injection instructions.
- Decide honestly in DESIGN: whether this is worth it vs. the local build
  script — the extender adds teamserver-side build tooling (node on the
  teamserver = attack surface + fingerprints). Default recommendation may
  be "keep local build"; the ticket records the analysis either way.

## Files
- create: `extender/` (or a `docs/` decision record if the answer is "don't")

## Acceptance
- Either: generate → inject → register round-trip from the Adaptix client
  on AdaptixTest, MDE gate clean. Or: a written, reasoned decision record
  to stay with local builds (closing the ticket as wontfix-with-reasons).
