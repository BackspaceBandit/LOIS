# 005: Discord injection e2e validation (fused-app path)

**Layer:** delivery · **Status:** open · **Priority:** P1 (blocks CS prod) · **Depends on:** 001

## Goal
The production deployment route is script-jacking (no `ELECTRON_RUN_AS_NODE`
launcher, no script path on any command line). `inject_unpacked.js` was built
for fused apps but has NEVER been run against a real target. Prove it on
Discord at DT-MDE-TEST.

## Scope
- Verify Discord's fuse state first (RunAsNode / OnlyLoadAppFromAsar /
  asar-integrity) — outcome decides whether `inject_unpacked` (unpacked
  script-jack) or `inject_asar` (repack) is the right route. Record findings
  in `docs/targets/discord.md`.
- Run `inject_unpacked.js --app <Discord app dir> --payload dist/support.js`,
  start Discord normally (as the user would), confirm: agent registers,
  `pwd`/`ls` round-trip, Discord UI/behavior normal, no crash on task errors.
- Restart the app: beacon returns (new registration — expected with
  `agent_id: auto`).
- `--clean` removes every artifact; verify zero residue.
- `Get-MpThreatDetection` empty throughout; also check Discord's own
  update-check still works (Squirrel).

## Files
- create: `docs/targets/discord.md` (fuse state, hook target used, versions
  tested, detection results)
- modify: `scripts/inject_unpacked.js` only if validation finds bugs

## Acceptance
- Beacon lives across app restart with NO persistence artifact added by us
  and no command-line artifact; MDE clean; user experience unchanged.
- Findings feed the recon tool (013) as its first verified profile.
