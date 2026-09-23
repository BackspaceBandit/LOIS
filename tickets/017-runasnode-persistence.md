# 017: ELECTRON_RUN_AS_NODE launcher-persistence helper (lab/permissive only)

**Layer:** delivery · **Status:** SKIPPED 2026-09-24 (operator decision — not needed for the current op set) · **Priority:** P3 · **Depends on:** 006 (documents the CS rule this violates)

## Why
The README roadmap lists a launcher/persistence helper for the
`ELECTRON_RUN_AS_NODE` mode (Run key / schtask wrapper). That mode leaves a
command-line artifact (host exe + script path) and a NEW autostart entry —
both forbidden on CS targets by ticket 006. It is still useful for labs,
permissive environments, and quick demos, so it gets built — fenced.

## Scope
- `scripts/persist_runasnode.js --app <electron.exe> --payload <bundle>
  [--name X]`: creates a Run-key entry (default) or schtask (`--schtask`)
  that sets `ELECTRON_RUN_AS_NODE=1` and launches the host exe with the
  payload path; `--clean` removes it.
- Hard warning on every use: "NOT for CS/Airlock targets — use injection
  (005/006)". The tool prints it and the deploy doc repeats it.
- Requires the target app's `RunAsNode` fuse to be ON (check via recon.js
  output, 013; refuse with explanation when off).

## Files
- create: `scripts/persist_runasnode.js`
- modify: `docs/deploy.md`

## Acceptance
- On DT-MDE-TEST: persistence survives logoff/reboot, beacon returns, MDE
  clean; `--clean` leaves zero residue; docs cross-link 006's rule.
