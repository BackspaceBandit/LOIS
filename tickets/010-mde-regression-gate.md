# 010: MDE regression gate (one-command winbox e2e)

**Layer:** testing/process · **Status:** open · **Priority:** P1 · **Depends on:** —

## Goal
Every LOIS change must be re-clearable against the MDE box in one command.
Today the steps are manual (build → scp → WMI launch → register check →
task round-trip → `Get-MpThreatDetection` → cleanup). Automate them.

## Design
- `scripts/gate_mde.sh` (operator machine): build → scp to DT-MDE-TEST →
  launch via `Win32_Process.Create` (survives ssh teardown; schtasks does
  NOT work without an interactive session — learned 2026-09-23) → poll
  AdaptixTest API for registration → send `pwd` via API (`ui:false` —
  `ui:true` silently becomes TASK_TYPE_BROWSER) → assert console answer →
  assert `Get-MpThreatDetection` empty → taskkill + clean artifacts.
- Config: env vars for box/teamserver/creds; fails CLOSED (any step red =
  gate red).
- Output: one-line PASS/FAIL per step, for paste into the tested-config
  record (012).

## Files
- create: `scripts/gate_mde.sh`

## Acceptance
- Clean run on unchanged codebase = PASS; deliberate broken build
  (e.g. wrong encrypt_key bake) = FAIL at the right step. Runtime < 5 min.
