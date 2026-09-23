# 011: CrowdStrike validation checklist (BLOCKED — no CS lab yet)

**Layer:** testing/process · **Status:** blocked (awaiting CS lab) · **Priority:** P2 · **Depends on:** 001, 005, 006, 010

## Goal
The definition-of-done waiting for the CS lab so validation is a checklist,
not an improvisation. Mirrors the MDE gate but adds the Falcon-specific
review surfaces.

## Checklist (draft — finalize when lab exists)
- Falcon console: zero detections/incidents for the test host during build,
  injection, beacon, and tasking windows.
- Process-tree review: host app process shows NO unexpected children
  (validates 001), no `ELECTRON_RUN_AS_NODE` command lines, no script-path
  arguments (validates 005).
- Network connections review: host process connections show only expected
  destinations; beacon destination matches the op domain story (008).
- Persistence/autostart review: no new entries (validates 006).
- 7-day dwell: agent runs a working-week without alerting (per ops rule:
  C2 established + undetected for a week = pass).

## Files
- create: `docs/cs-validation.md` (when lab exists; this ticket is the stub)

## Acceptance
- All boxes ticked on the CS lab before any prod deploy against a CS target;
  results stamped into the tested-config record (012).
