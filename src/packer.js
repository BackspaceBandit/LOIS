// packer.js — Adaptix beacon Packer/Unpacker port (big-endian).
// Source: beacon_agent/src_beacon/beacon/Packer.cpp — Pack32/16/8 write BE;
// PackBytes = u32be(len) + raw; PackStringA = PackBytes(utf8) with NO NUL.
class Packer {
  constructor() { this.parts = []; }
  u8(v)  { this.parts.push(Buffer.from([v & 0xff])); return this; }
  u16(v) { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(v & 0xffff, 0); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(v >>> 0, 0); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.allocUnsafe(8); b.writeBigUInt64BE(BigInt(v) & 0xffffffffffffffffn, 0); this.parts.push(b); return this; }
  bytes(data, size) {
    if (size === undefined || size === null) size = data.length;
    this.u32(size);
    this.parts.push(Buffer.from(data).subarray(0, size));
    return this;
  }
  str(s) { const b = Buffer.from(String(s), 'utf8'); return this.bytes(b, b.length); }
  data() { return Buffer.concat(this.parts); }
}
class Unpacker {
  constructor(buf) { this.buf = buf; this.i = 0; }
  u8()  { const v = this.buf[this.i]; this.i += 1; return v; }
  u16() { const v = this.buf.readUInt16BE(this.i); this.i += 2; return v; }
  u32() { const v = this.buf.readUInt32BE(this.i); this.i += 4; return v >>> 0; }
  bytes() { const n = this.u32(); const b = this.buf.subarray(this.i, this.i + n); this.i += n; return b; }
  str() { return this.bytes().toString('utf8'); }
}
module.exports = { Packer, Unpacker };
