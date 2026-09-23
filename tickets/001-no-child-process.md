# 001: Eliminate child_process from the agent (process-chain IOA surface)

**Layer:** core runtime · **Status:** done 2026-09-23 (suite 10/10; live e2e
on DT-MDE-TEST: register + pwd round-trip, MDE clean) · **Priority:** P1 (blocks CS prod) · **Depends on:** —

## Goal
Zero `child_process` usage anywhere in the built artifact. Today there are
two violations, both visible as `ElectronHost.exe → child exe` process chains
— CrowdStrike's strongest signal class against us:

1. `src/config.js` (`hostInfo`): `execSync('net session')` elevation probe,
   fired once per host-app start. `net.exe` under Discord.exe is a classic
   recon-pattern IOA.
2. `src/fsops.js` (`psList`, win32): `execSync('tasklist /fo csv /nh')` on
   every `ps` command.

## Design
- Elevation: drop the probe. Report `elevated: false` (or add optional
  sidecar/env override `LW_ELEVATED=1` for ops that know). Server-side this
  field is cosmetic; a wrong `false` is cheaper than a `net.exe` spawn.
- `ps` win32: pure Node has no Toolhelp32 binding. Options in order:
  a) win32 `ps` returns the error frame ("unsupported on this build") —
     honest, zero signal; operator falls back to server-side tooling;
  b) parse via `process` APIs — does not exist for foreign processes;
  c) keep `tasklist` behind an explicit `--allow-shellout` build flag,
     default OFF, documented as CS-unsafe.
  Implement (a) as default, (c) as the escape hatch.
- posix `/proc` path stays (no child process there).

## Files
- modify: `src/config.js` (remove probe), `src/fsops.js` (ps gate),
  `scripts/build_payload.js` (flag), `test/run_tests.js` (denylist assert)

## Acceptance
- `test/run_tests.js` asserts the built artifact matches neither
  `child_process` nor `tasklist|net session`.
- Suite green; win32 e2e: `ps` returns error frame, everything else
  unchanged; MDE regression gate clean.
