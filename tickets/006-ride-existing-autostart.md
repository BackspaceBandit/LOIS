# 006: Ride-existing-autostart deploy helper

**Layer:** delivery/persistence · **Status:** open · **Priority:** P1 · **Depends on:** 005

## Goal
We add ZERO persistence artifacts. Host apps like Discord already autostart
(Squirrel registers an `Update.exe` Run key / startup entry); injected code
rides it. Creating our own Run key or schtask is exactly the telemetry Falcon
scrolls first. This ticket makes "no new autostart" enforceable.

## Scope
- `scripts/check_autostart.js <app>`: verifies the host's OWN autostart
  mechanism exists (registry Run entry / Startup folder link, per target
  profile from 005/013) and prints what the injected agent's boot story is.
  It must NEVER write anything — read-only assertion.
- Deploy doc rule: if the target app has no autostart, the answer is a
  different host app or an operator decision — not a new Run key.
- Runbook note: registration-per-boot is expected (auto agent_id); operators
  reconcile dead agents on the teamserver.

## Files
- create: `scripts/check_autostart.js`, `docs/deploy.md` (persistence rules)

## Acceptance
- Helper correctly reports autostart presence/absence for Discord, VS Code,
  GitHub Desktop on DT-MDE-TEST.
- Deploy doc states the rule; code review confirms no write paths.
