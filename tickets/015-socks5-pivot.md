# 015: SOCKS5 pivot over the tunnel channel

**Layer:** capability · **Status:** open · **Priority:** P2 · **Depends on:** 001 (no new child_process), 003

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
