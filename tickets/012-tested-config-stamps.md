# 012: Tested-config stamps per EDR

**Layer:** process/tooling · **Status:** open · **Priority:** P2 · **Depends on:** 010

## Goal
Same idea as the HOI.SIN EDR presets: a LOIS build must carry a visible,
operator-confirmed record of what it was last tested against — so an
untested build shape can never be deployed by accident.

## Design
- `tested.json` in the repo root (informational only, human-updated):
  per EDR (`mde`, `crowdstrike`, `sentinelone`, …): `{ last_tested,
  build_hash, config_summary, result, tester }`.
- `build_payload.js` prints the matching stamp (or "UNTESTED FOR THIS
  CONFIG") at build time by hashing the effective config and comparing
  against `tested.json`. Mismatch = loud warning, not a block (operator
  judgment stays in the loop).
- Stamps are manual (per user decision on the HOI.SIN side): a human
  confirms after real testing; the tool only makes staleness visible.

## Files
- create: `tested.json`
- modify: `scripts/build_payload.js`

## Acceptance
- Building with the exact MDE-gate config after a recorded PASS prints the
  stamp + date; changing any effective-config field prints UNTESTED.
