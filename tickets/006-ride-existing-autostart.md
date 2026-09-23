# 006: Ride-existing-autostart deploy helper — DESCOPED

**Layer:** delivery/persistence · **Status:** descoped 2026-09-23 (operator:
autostart is not a requirement right now) · **Priority:** P3 · **Depends on:** 005

## Standing rule (still in force)
We never ADD autostart artifacts (no new Run keys, no schtasks) on EDR
targets — that rule lives in `docs/deploy.md` and ticket 017's fence. The
agent simply runs when the user launches the host app; for dev-workstation
cover apps (VS Code, GitHub Desktop) that is operationally sufficient and
is itself the low-signature choice.

## Original scope (deferred until persistence becomes a requirement)
- `scripts/check_autostart.js <app>`: read-only assertion that the host's
  OWN autostart mechanism exists (Squirrel `Update.exe` Run key etc.) and
  what the injected agent's boot story would be. Never writes anything.
- Deploy doc: if the target app has no autostart, the answer is a different
  host app or an operator decision — never a new artifact.
- Runbook note: registration-per-launch is expected (`agent_id: auto`);
  operators reconcile dead agents on the teamserver.

## Files (when revived)
- create: `scripts/check_autostart.js`, `docs/deploy.md` (persistence rules)

## Acceptance (when revived)
- Helper correctly reports autostart presence/absence for VS Code and
  GitHub Desktop (primary targets) plus Discord (reference) on DT-MDE-TEST.
- Deploy doc states the rule; code review confirms no write paths.
