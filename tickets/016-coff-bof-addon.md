# 016: Optional COFF/BOF addon (non-Airlock targets only)

**Layer:** capability · **Status:** SKIPPED 2026-09-24 (operator decision — not needed for the current op set) · **Priority:** P3 · **Depends on:** 001

## Why
BOF execution requires a native `.node` addon (COFF loader) — which is a DLL
load inside the Electron host. That is *exactly* what Airlock blocks and a
load Falcon annotates. It is therefore **never acceptable on the primary
target set** and exists only for permissive/non-EDR environments where the
operator explicitly wants BOFs from the JS channel.

## Scope
- `addons/coff/`: small native COFF loader (`coffloader.node`), built at
  addon-build time (NOT part of the default payload pipeline).
- Agent loads it ONLY when the sidecar/baked config sets
  `"coff_addon": "<abs path>"` AND the file exists; any failure = BOF
  commands return the error frame. Default build ships no addon, no require
  of it (static-analysis clean: the string `coffloader` must not appear in
  the default artifact).
- Wire: EXEC_BOF (50) / EXEC_BOF_OUT (51) handlers per
  `beacon_agent/pl_main.go` + `JobsController` semantics.
- Docs: explicit "when is this acceptable" section (never on Airlock/CS
  targets; fine vs. bare AV or EDR-lite).

## Files
- create: `addons/coff/` (binding.gyp, loader), `src/bof.js`
- modify: `src/agent.js` (gated dispatch), `test/run_tests.js`

## Acceptance
- Default artifact contains no addon reference; suite proves gating.
- On a non-MDE lab box with the addon present: `whoami.o` round-trip via the
  teamserver BOF command; MDE box WITHOUT addon: BOF task returns a clean
  error frame, zero detections.
