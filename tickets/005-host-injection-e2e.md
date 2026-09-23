# 005: Host-app injection e2e — VS Code (primary) + GitHub Desktop

**Layer:** delivery · **Status:** done 2026-09-23 (both targets validated on
DT-MDE-TEST, MDE clean; profiles in docs/targets/) · **Priority:** P1 (blocks CS prod) · **Depends on:** 001

## Outcome notes (what validation actually found)
- BOTH targets are **loose-file** Electron apps — no asar repack needed:
  VS Code 1.139 ships `resources\app\` loose (only `node_modules.asar`
  exists) in an MSIX-flavored layout (`<install>\<commit-hash>\resources`,
  `resourcesPath` resolves into the hash dir); GitHub Desktop 3.6.6 ships
  loose `resources\app\main.js`. `inject_unpacked.js --target` covers both.
- **Real bug caught:** VS Code's `out\main.js` is ESM — the original
  `require()` hook silently no-ops there. Hook switched to guarded dynamic
  `import()` (works in CJS + ESM mains). Suite regressed it (test 6d).
- VS Code `product.json` checksums do NOT cover `out\main.js` → no
  "[Unsupported]" banner.
- Fuses identical on both: `101100011` (asarIntegrity=0,
  onlyLoadAppFromAsar=0, runAsNode=1).
- Operator-side ergonomics: injectors run ON the box via the app's own
  Electron as a node runtime (`ELECTRON_RUN_AS_NODE=1 Code.exe
  inject_unpacked.js ...`) — no node install needed on target.
- Sidecar (`support.json`) deleted post-inject: encrypted bake (004) carries
  config; plaintext sidecar is an avoidable IoC.

## Original scope (all executed)
- VS Code: inject → WMI launch → register → `pwd` round-trip → normal
  process tree → restart re-registers → `--clean` zero residue → app boots
  clean. MDE: zero detections.
- GitHub Desktop: same battery with `ls` round-trip. MDE: zero detections.
- docs/targets/vscode.md + docs/targets/github-desktop.md written.

## Target note (2026-09-23, operator decision)
Primary host apps are **VS Code** and **GitHub Desktop** — Discord does not
exist in most customer/dev environments and is bad cover there. Both are
Squirrel/NSIS-class Electron apps commonly found on dev workstations.
Discord stays in-tree only as the fused-app reference case; the
`inject_unpacked` path gets validated when a fused target actually matters
(e.g. Slack 4.x).

## Goal
The production deployment route is script-jacking (no `ELECTRON_RUN_AS_NODE`
launcher, no script path on any command line). Prove it end-to-end on
DT-MDE-TEST against the real apps.

## Scope
- Read fuse state for both apps first (recon by hand or via 013 when built):
  VS Code is expected to take the `inject_asar` repack route (unfused);
  GitHub Desktop TBD by its fuses. Record in `docs/targets/vscode.md` /
  `docs/targets/github-desktop.md`.
- VS Code: `inject_asar.js --app <VS Code dir> --payload dist/support.js`.
  Launch Code normally; confirm: agent registers, `pwd`/`ls` round-trip,
  editor fully functional, no crash on task errors, no "corrupt install"
  UI marker that a user would report (VS Code shows an integrity warning in
  some builds — if it appears, assess and document; decide acceptability).
- GitHub Desktop: same battery via whichever route its fuses allow.
- Restart apps: beacon returns (new registration — expected, `agent_id: auto`).
- `--clean` removes every artifact; verify zero residue on both.
- `Get-MpThreatDetection` empty throughout; apps' own update checks intact.

## Files
- create: `docs/targets/vscode.md`, `docs/targets/github-desktop.md`
- modify: `scripts/inject_asar.js` only if validation finds bugs

## Acceptance
- Beacon lives across app restarts with NO persistence artifact added by us
  and no command-line artifact; MDE clean; user experience unchanged on
  both apps. Findings seed the recon tool's target profiles (013).
