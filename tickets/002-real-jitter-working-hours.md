# 002: Real jitter + working-hours enforcement

**Layer:** core runtime (network cadence) · **Status:** open · **Priority:** P2 · **Depends on:** —

## Goal
The beacon loop currently reproduces upstream's `WaitMask.cpp` unit quirk:
`dt = rand % (sleep*jitter/100)` is computed in seconds but subtracted from
milliseconds, so effective jitter is ~5 ms on a 30 s sleep — statistically
flat cadence, which is exactly what NDR/EDR beaconing heuristics look for.
Also: the PROFILE `working_time` value (sub 4) is parsed and stored but never
enforced.

## Design
- `src/agent.js` `jittered()`: real percentage jitter
  (`sleep*1000 ± rand(sleep*1000*jitter/100)`), default on.
- New config `compat_quirk` (default `false`; `true` reproduces the legacy
  envelope for protocol-parity testing only).
- Enforce `working_time` (packed start/end hour window per upstream
  semantics — verify against `Agent.cpp` working-time handling before
  implementing): outside the window, sleep until window start; no beacons.
- Killdate already parsed (`cfg.kill_date`, PROFILE sub 3): enforce — at/after
  epoch, exit loop silently (currently stored, never checked).

## Files
- modify: `src/agent.js`, `src/config.js`, `test/run_tests.js`

## Acceptance
- Suite: timing test asserts observed intervals fall inside the jitter
  envelope (mock listener, accelerated sleep) and zero beats outside a
  configured working window; killdate exits.
- Live check vs `loistest`: server-observed inter-arrival times match.
