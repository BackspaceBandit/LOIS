# LOIS tickets

Opsec hardening plan for production deployment against CrowdStrike-class
EDR (proposed 2026-09-23, after MDE e2e pass). Threat-model shift: MDE leans
on signatures/AMSI; Falcon leans on process-chain IOAs, command lines,
persistence telemetry, per-process network attribution.

## Priority order

| # | Ticket | Pri | Layer | Blocks CS prod? |
|---|--------|-----|-------|-----------------|
| 001 | no child_process (net session / tasklist) | P1 | runtime | YES |
| 005 | host-app injection e2e — VS Code + GitHub Desktop | P1 | delivery | YES |
| 003 | crash containment audit | P1 | runtime | YES |
| 008 | prod listener profile generator | P1 | c2/infra | YES |
| 010 | MDE regression gate script | P1 | testing | YES |
| 004 | artifact string encryption | P2→early (operator request) | build | |
| 002 | real jitter + working hours | P2 | runtime | |
| 007 | update-resilience runbook | P2 | delivery | |
| 012 | tested-config stamps | P2 | process | |
| 013 | recon.js target assessment | P2 | tooling | |
| 011 | CS validation checklist | P2 | testing | BLOCKED: no CS lab |
| 009 | residual network-risk doc | P3 | docs | |
| 006 | ride existing autostart | P3 | delivery | DESCOPED: autostart not required (operator, 2026-09-23) |

## Suggested sequencing

1. Wave 1 (kill the loud signals): 001 → 004 → 005 → 008
   (004 promoted per operator; 006 descoped — autostart not required)
2. Wave 2 (hardening): 003 → 002 → 010
3. Wave 3 (process): 012, 013, 007, 009; 011 when the CS lab lands.

## Capability roadmap (post-hardening)

| # | Ticket | Pri | Notes |
|---|--------|-----|-------|
| 014 | NaX HTTP channel transport | done 2026-09-24 | live-validated vs testhttp2 from DT-MDE-TEST |
| 015 | SOCKS5 pivot (tunnel tasks) | done 2026-09-23 | live pivot through MDE-box beacon |
| 016 | COFF/BOF addon | SKIPPED | operator decision 2026-09-24 — BOFs via NaX instead |
| 017 | run-as-node persistence helper | SKIPPED | operator decision 2026-09-24 |
| 018 | teamserver extender | SKIPPED | operator decision 2026-09-24 — local builds stay |

Rules of the house: one ticket = one change; suite + MDE gate green before
any ticket is marked done; ticket files updated when scope changes.

Target note (operator, 2026-09-23): primary host apps are **VS Code** and
**GitHub Desktop** — Discord is absent from most target environments and
remains only as the fused-app reference case.
