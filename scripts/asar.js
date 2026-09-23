// asar.js — zero-dependency ASAR read/write (pack/unpack/verify).
// Format: u32le header-size-pickle | header pickle (u32le json-len pad4, JSON)
//         | file blobs at header offsets.
// Integrity (Electron fuse-compatible shape): per file, SHA256 of the whole
// file + SHA256 per 4MB block, stored in the header entry.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BLOCK = 4 * 1024 * 1024;

function align4(n) { return (n + 3) & ~3; }

function integrityFor(buf) {
  const blocks = [];
  for (let off = 0; off < buf.length; off += BLOCK)
    blocks.push(crypto.createHash('sha256').update(buf.subarray(off, off + BLOCK)).digest('hex'));
  return { algorithm: 'SHA256',
           hash: crypto.createHash('sha256').update(buf).digest('hex'),
           blockSize: BLOCK, blocks };
}

// ---- read ------------------------------------------------------------------
function readArchive(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head8 = Buffer.allocUnsafe(8);
    fs.readSync(fd, head8, 0, 8, 0);
    const headerPickleSize = head8.readUInt32LE(4); // size of the pickle that follows
    const hdrBuf = Buffer.allocUnsafe(headerPickleSize);
    fs.readSync(fd, hdrBuf, 0, headerPickleSize, 8);
    const jsonLen = hdrBuf.readUInt32LE(0);
    const header = JSON.parse(hdrBuf.subarray(4, 4 + jsonLen).toString('utf8'));
    const dataOffset = 8 + headerPickleSize;
    return { header, dataOffset };
  } finally { fs.closeSync(fd); }
}

function walk(node, cb, prefix = '') {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, cb, p);
    else cb(p, entry);
  }
}

function readFileBytes(asarPath, arch, entry) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(entry.size);
    fs.readSync(fd, buf, 0, entry.size, arch.dataOffset + parseInt(entry.offset, 10));
    return buf;
  } finally { fs.closeSync(fd); }
}

function extract(asarPath, outDir) {
  const arch = readArchive(asarPath);
  walk(arch.header, (p, entry) => {
    const dest = path.join(outDir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readFileBytes(asarPath, arch, entry));
  });
  return arch;
}

// ---- write -----------------------------------------------------------------
function pack(srcDir, opts = {}) {
  const header = { files: {} };
  const blobs = [];
  let offset = 0;
  (function walkDir(dir, node) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        const sub = { files: {} };
        node.files[name] = sub;
        walkDir(abs, sub);
      } else {
        const data = fs.readFileSync(abs);
        const entry = { size: data.length, offset: String(offset) };
        if (opts.integrity) entry.integrity = integrityFor(data);
        node.files[name] = entry;
        blobs.push(data);
        offset += data.length;
      }
    }
  })(srcDir, header);

  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const jsonFieldLen = align4(json.length);
  const pickleSize = 4 + jsonFieldLen;             // u32 json-len + padded json
  const totalHeader = 4 + pickleSize;              // u32 pickle-size + pickle
  const out = Buffer.allocUnsafe(align4(totalHeader));
  out.writeUInt32LE(pickleSize, 0);                // size of the header pickle
  out.writeUInt32LE(jsonFieldLen, 4);              // json field length (padded)
  json.copy(out, 8);
  return { headerBuf: out, blobs };
}

function writeArchive(asarPath, packed) {
  const fd = fs.openSync(asarPath, 'w');
  try {
    fs.writeSync(fd, packed.headerBuf);
    for (const b of packed.blobs) fs.writeSync(fd, b);
  } finally { fs.closeSync(fd); }
}

// recompute and compare every file's integrity block (fuses view)
function verify(asarPath) {
  const arch = readArchive(asarPath);
  const bad = [];
  walk(arch.header, (p, entry) => {
    if (!entry.integrity) return;
    const data = readFileBytes(asarPath, arch, entry);
    const want = integrityFor(data);
    if (want.hash !== entry.integrity.hash) bad.push(p);
  });
  return bad;
}

module.exports = { readArchive, walk, readFileBytes, extract, pack, writeArchive, verify };
