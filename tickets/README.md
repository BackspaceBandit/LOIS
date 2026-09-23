# LOIS tickets

Opsec hardening plan for production deployment against CrowdStrike-class
EDR (proposed 2026-09-23, after MDE e2e pass). Threat-model shift: MDE leans
on signatures/AMSI; Falcon leans on process-chain IOAs, command lines,
persistence telemetry, per-process network attribution.

## Priority order

| # | Ticket | Pri | Layer | Blocks CS prod? |
|---|--------|-----|-------|-----------------|
| 001 | no child_process (net session / tasklist) | P1 | runtime | YES |
| 005 | Discord injection e2e (fused path) | P1 | delivery | YES |
| 006 | ride existing autostart | P1 | delivery | YES |
| 003 | crash containment audit | P1 | runtime | YES |
| 008 | prod listener profile generator | P1 | c2/infra | YES |
| 010 | MDE regression gate script | P1 | testing | YES |
| 002 | real jitter + working hours | P2 | runtime | |
| 004 | artifact string encryption | P2 | build | |
| 007 | update-resilience runbook | P2 | delivery | |
| 012 | tested-config stamps | P2 | process | |
| 013 | recon.js target assessment | P2 | tooling | |
| 011 | CS validation checklist | P2 | testing | BLOCKED: no CS lab |
| 009 | residual network-risk doc | P3 | docs | |

## Suggested sequencing

1. Wave 1 (kill the loud signals): 001 → 005 → 006 → 008
2. Wave 2 (hardening): 003 → 002 → 004 → 010
3. Wave 3 (process): 012, 013, 007, 009; 011 when the CS lab lands.

## Capability roadmap (post-hardening)

| # | Ticket | Pri | Notes |
|---|--------|-----|-------|
| 014 | NaX HTTP channel transport | P1 (real ops) | replaces signatured stock channel; needs 001/002 first |
| 015 | SOCKS5 pivot (tunnel tasks) | P2 | highest-value capability gap; pure-JS `net` |
| 016 | COFF/BOF addon | P3 | NEVER on Airlock/CS targets (native load) |
| 017 | run-as-node persistence helper | P3 | lab/permissive only — violates 006 by design |
| 018 | teamserver extender | P3 | may close as wontfix (local build is fine) |

Rules of the house: one ticket = one change; suite + MDE gate green before
any ticket is marked done; ticket files updated when scope changes.
