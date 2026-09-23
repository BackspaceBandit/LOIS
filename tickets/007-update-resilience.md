# 007: Update-resilience runbook + re-inject idempotence

**Layer:** delivery · **Status:** done 2026-09-23 (docs/runbook.md; re-inject idempotence asserted in suite 6d; clean+reinject cycle also exercised live during 005) · **Priority:** P2 · **Depends on:** 005

## Goal
App updates kill the hook silently: Squirrel replaces the whole versioned
dir (GitHub Desktop), NSIS rewrites the asar in place (VS Code). Define the
operator workflow and make re-injection safe.

## Scope
- `inject_unpacked.js` / `inject_asar.js`: detect an already-hooked target
  (marker present) and refuse/no-op cleanly; `--clean` then re-run is the
  documented re-inject path. (Marker exists — verify both paths.)
- `docs/runbook.md`: detect update (beacon gone after app update, new
  version dir), re-inject, verify, reconcile dead agents on the teamserver.
- Optional (flagged in runbook, not built): a watcher that re-injects on
  version-dir change. Explicitly NOT default — a resident watcher is its own
  persistence artifact.

## Files
- modify: `scripts/inject_unpacked.js`, `scripts/inject_asar.js`
- create: `docs/runbook.md`

## Acceptance
- Re-running an injector on an already-hooked app is a clean no-op;
  `--clean` + re-inject restores the beacon after a simulated update
  (copy a fresh VS Code install over the hooked one) on DT-MDE-TEST;
  MDE clean.
