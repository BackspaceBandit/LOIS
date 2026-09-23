# 013: recon.js — Electron target assessment tool

**Layer:** delivery/tooling · **Status:** open · **Priority:** P2 · **Depends on:** —

## Goal
"Found a new program, can we inject?" should be a 30-second check, not
manual analysis. One script takes an install directory and reports the full
injectability assessment.

## Assessment output
1. **Is it Electron at all** — `resources/app.asar` present, binary is
   Electron (version string). Non-Electron → out of LOIS scope, point at
   HOI.SIN instead.
2. **Fuse state** (decides the route): scan the binary for the Electron
   fuse sentinel + JSON config — report `RunAsNode`,
   `OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation`,
   `EnableNodeOptionsEnvironmentVariable`.
3. **Route recommendation**:
   - integrity validation OFF → `inject_asar` (repack, default);
   - integrity validation ON + `OnlyLoadAppFromAsar` OFF +
     boot-loaded JS under `resources/app.asar.unpacked/` → `inject_unpacked`
     (list the candidate hook files it found, ranked — `bindings/bindings.js`
     class first);
   - both ON → not injectable with current tooling (report only).
4. **Autostart story** (from 006): does the app self-register autostart.
5. **Update mechanism** (Squirrel `Update.exe` / NSIS / none) — durability
   note for the runbook (007).

## Design
Zero-dep Node script, read-only on the target dir. Results writable as a
`docs/targets/<app>.md` stub so verified targets accumulate as profiles.

## Files
- create: `scripts/recon.js`
- create: `docs/targets/` (seeded from 005's Discord findings)

## Acceptance
- Correctly classifies the three lab apps (Discord → unpacked route,
  VS Code → asar route, GitHub Desktop → whichever its fuses say) on
  DT-MDE-TEST; correct "not Electron" verdict on a non-Electron control.
