# 004: Static artifact string encryption (--enc-strings)

**Layer:** build pipeline · **Status:** done 2026-09-23 (suite 10/10; artifact
verified: no URI/UA/hb-header/key/template strings; live e2e via encrypted
bake, MDE clean) · **Priority:** P2 · **Depends on:** —

## Goal
The built payload today is minified + token-renamed + comment-stripped, but
config strings (URI, UA, response template, header names) and library error
strings sit in the artifact in plaintext — one `strings`/`yara` pass on the
dropped file burns the config. Encrypt them.

## Design
- Hand-rolled, zero-dep (keeps the no-supply-chain promise; no
  javascript-obfuscator). Build time: collect string literals, store as an
  XORed byte-array table; runtime: tiny decoder with the key assembled from
  parts at first use (no key literal in the file).
- `scripts/build_payload.js --enc-strings` flag, default ON for
  `--mode prod` (see 012); off for dev builds (debuggability).
- Must NOT encrypt: strings that are file-format-visible contracts with the
  host (module paths in the hook line come from the injector, unaffected).
- Keep the existing hygiene denylist + per-build token rename; this stacks.

## Files
- modify: `scripts/build_payload.js`, `test/run_tests.js`

## Acceptance
- Suite round-trips an `--enc-strings` build against the mock listener
  (register + pwd/ls/mkdir) — green.
- `strings dist/support.js` shows none of: URI, UA, `hb_header`, template
  markers, `PAYLOAD_DATA`, error strings.
- Live e2e vs `loistest` on the MDE box, zero detections.
