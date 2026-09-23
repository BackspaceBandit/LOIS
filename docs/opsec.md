# LOIS opsec notes

## Residual network risk (read before any prod deploy)

The thing we **cannot** engineer away: a signed Electron host (e.g.
`Code.exe`) POSTing on a cadence to a domain it has no business with.
Per-process network attribution (Falcon network telemetry, any decent NDR)
sees `host-process → our-domain` regardless of how pretty the profile is.

**Mitigations in place**

- Aged domain + valid LE cert (TLS terminates at the redirector; nothing
  plain-HTTP leaves the target network).
- GUID-gated path on the redirector — ungated traffic hits the fake site /
  404 profile (ticket: nginx `location ^~ /<guid>/` model).
- Profile realism: op-specific UA/URIs/template via `gen_profile.js`;
  never the signatured upstream defaults.
- Cadence: real jitter (002), working-hours windows, killdate; prod minimums
  enforced by the generator (sleep ≥ 60 s, jitter ≥ 20 %).
- Our patched watermark (`0x5f3a91c2`) — not the upstream default.

**What remains**

- *Process→domain mismatch.* Discord.exe talking to non-Discord domains,
  Code.exe talking to a notes site. Mitigate by matching the domain story to
  the host app's plausible traffic (a sync/notes/productivity theme for dev
  tools, not "cdn-tracking-metrics.example").
- *Cadence regularity under long observation.* Real jitter helps; a week of
  perfect 60 s±35 % POSTs to one domain is still a pattern. Longer sleeps
  cost responsiveness — that's the trade, decide per op.
- *Beat size fingerprint.* Fixed-size-ish heartbeats in both directions.
  Not addressed in v1 (would need padding profiles server-side).

**Escape hatch (not built):** upstream `beacon_listener_dns` exists; DNS
channels change the signature class entirely. Decide if/when needed — do not
build speculatively.

## Operator mistakes that burn us (checklist)

- Plain HTTP to a public IP (no redirector, no TLS).
- Any default value in a prod profile (URI, UA, template, hb header).
- sleep < 60 s in prod.
- `--allow-shellout` or debug builds on an EDR target.
- `ELECTRON_RUN_AS_NODE` launcher on a real target (command-line artifact) —
  lab only.
- Leaving the injector's plaintext sidecar on disk when the payload has an
  encrypted bake — delete `support.json` after injecting.
- New autostart artifacts (Run keys/schtasks) on EDR targets — never.
- Skipping `gate_mde.sh` because "nothing changed" (012 prints UNTESTED for
  a reason).
