# 003: Crash containment audit + fault-injection tests

**Layer:** core runtime · **Status:** done 2026-09-23 (suite 16/16; fault
tests: reset/garbage/badkey/badtask/EACCES all survived) · **Priority:** P1 · **Depends on:** —

## Outcome notes
- Real bug found: the HTTP response stream had no `error` handler — a server
  dying mid-body would throw an uncaughtException **in the host app's main
  process**. Fixed in `request()`.
- `hostInfo` probes (`os.userInfo/hostname/networkInterfaces/release/type`)
  are all guarded now.
- Pre-existing hygiene gap found via the new assertions: several `log()`
  call sites were mid-line and survived stripping, and esbuild does not
  reliably DCE the unused helper — hygiene now physically removes the
  `log`/`ts` helper definitions and the dev-only fatal print; suite asserts
  zero `console.*`/log-message strings in the artifact.
- `MAX_CYCLES` env knob renamed into the per-build prefix scheme
  (`LOIS_MAX_CYCLES` → random prefix per build).

## Goal
Injected, we share the host app's main process. One unguarded throw = host
crash = WER dialog/dump (our JS can ship to Microsoft in the dump) plus a
user-visible anomaly. `entry.js` already guarantees load-time safety and the
tick loop wraps task handling; this ticket closes the remaining gaps and
proves it.

## Scope
- Audit every synchronous call on the tick path: `buildBeat`/`hostInfo`
  (fs/os calls), `request()` write paths, `fsops` handlers, download pump.
  Anything that can throw must be inside an existing try/catch or get one.
- Agent-fatal errors must fail SILENT (beacon dies, host unaffected) —
  never `process.exit` on a path that can race host startup, never rethrow.
- No `process.on('uncaughtException')` global swallow: it would mask HOST
  bugs too (violates the entry.js contract). Contain our own frames only.
- Verify: no `console.*` in prod build path (hygiene already strips; add a
  suite assertion so a future debug line can't regress).

## Files
- modify: `src/agent.js`, `src/fsops.js`, `src/beat.js`, `src/config.js` (as
  audit finds), `test/run_tests.js`

## Acceptance
- New fault tests in suite: listener down mid-task, malformed task stream
  (truncated/wrong key), fs EACCES on cwd/cat/upload/download, huge PS list.
  Agent survives or dies silently; in the Electron-harness test the host
  process must stay alive and functional in every case.
- MDE regression gate clean.
