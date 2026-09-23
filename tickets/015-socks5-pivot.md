# 015: SOCKS5 pivot over the tunnel channel

**Layer:** capability · **Status:** done 2026-09-23 (suite 19/19 incl. tunnel
connect/write/close; live e2e: socks5 pivot through the MDE-box beacon to the
internet, HTTP 301 via 1.1.1.1; MDE clean) · **Priority:** P2 · **Depends on:** 001 (no new child_process), 003

## Outcome notes
- `src/tunnel.js`: TCP channels (connect/write/pause/resume/close), status
  frames in the taskId-slot framing the server expects, WSA error mapping
  (10061/10060/10065 → proper SOCKS5 reply codes client-side), C++ watermark
  backpressure (4 MB pause / 1 MB resume / 16 MB cap), sockets `unref`'d and
  torn down on agent exit.
- Frames flush into EVERY beat (task replies and quiet ticks), so pivot data
  flows without waiting for tasks.
- Live test notes: `/tunnel/start/socks5` needs `"listen": true` to bind the
  socks port ON the teamserver (default false = bind on a connected GUI
  client — nothing binds with API-only operation). Stop param is
  `p_tunnel_id`.
- Expected pivot latency with sleep 5 ≈ 25-30 s per request (several beat
  round-trips per connect+response) — interactive tooling works, bulk
  transfer does not. Lower sleep while tunneling, or live with it.
- Deferred (as written in the ticket): UDP, reverse tunnels, WS push relay.

## Why
Pure-JS Node can open arbitrary TCP (`net` module) — a SOCKS pivot turns a
beached Electron host into a network foothold without dropping any proxy
tool. This is the highest-value missing capability for ops (reach internal
services through the beacon). YADDA proved the pattern works in Electron.

## Scope
- Implement the Adaptix tunnel task family in LOIS (constants already in
  `src/tasks.js`: `TUNNEL_START 62 / TUNNEL_WRITE 64 / TUNNEL_CLOSE 66 /
  TUNNEL_PAUSE 69 / TUNNEL_RESUME 70`; wire packing per
  `beacon_agent/pl_main.go` `TunnelMessageConnectTCP/Write/Close/...` and
  the C++ `Proxyfire.cpp` behavior):
  - TUNNEL_START (tcp): parse channelId/addressType/address/port, open
    `net.connect`, reply per protocol;
  - TUNNEL_WRITE: channelId + data → socket; socket data → next tick's
    reply stream (chunked, bounded so a big transfer can't starve the beat);
  - TUNNEL_CLOSE / PAUSE / RESUME semantics; clean teardown on listener
    death (no dangling sockets keeping the host's event loop alive on
    shutdown — host app must still quit cleanly).
- Teamserver side is stock: operator starts `socks5` tunnel on the agent
  (API `/tunnel/start/socks5` or client UI), traffic flows through the
  existing beat channel.
- Throughput reality check in docs: sleep-bound channel — fine for
  RDP/browse-style interactive use, not for bulk transfer; document
  recommended sleep-override while tunneling (if the protocol supports a
  burst/wake mechanism in the stock listener, use it; otherwise document
  the trade-off).

## Deferred (note in ticket, not built)
The YADDA-style operator WS relay (push channel for lower-latency
tasking) — separate decision; current stock channel is poll-based and
that is acceptable for v1 of this feature.

## Files
- create: `src/tunnel.js`
- modify: `src/agent.js` (dispatch + tick integration), `src/tasks.js`,
  `test/run_tests.js`, `test/mock_listener.js` (tunnel emulation)

## Acceptance
- Suite: mock tunnel open/write/close round-trip green.
- Live on AdaptixTest: start socks5 tunnel to the LOIS agent, curl an
  HTTP service on the DT-MDE-TEST side through it (`--socks5`), then via
  RDP/SSH equivalent smoke; MDE gate clean; host app quits cleanly with a
  tunnel open.
