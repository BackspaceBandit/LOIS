// mock_nax.js — minimal NoNameAx (NaX) listener for tests (ticket 014).
// Registration: POST raw body = AES(REGISTER) -> reply AES(PROFILE v2).
// GET: Cookie __cid = base64(AES(HEARTBEAT)) -> AES(TASK frames | NO_TASKS).
// POST (registered): AES(RESULT) -> print -> AES(NO_TASKS).
// Env: LISTEN_PORT, LISTEN_KEY (16B hex). Tasks: --tasks <ndjson>
//   {"cmd":21}        pwd        {"cmd":16} whoami
//   {"cmd":22,"path":p}  mkdir    {"cmd":25,"path":p} ls    {"cmd":17,"ms":n,"jitter":j} sleep
const http = require('http');
const fs = require('fs');
const { frame, walkFrames, aesEnc, aesDec, T } = require('../src/nhttp');

const PORT = parseInt(process.env.LISTEN_PORT || '0', 10) || 0;
const KEY = Buffer.from(process.env.LISTEN_KEY || '00112233445566778899aabbccddeeff', 'hex');
const TASKS_FILE = process.argv.includes('--tasks') ? process.argv[process.argv.indexOf('--tasks') + 1] : null;
const BID = process.env.LISTEN_HB || 'X-Correlation-Id';

// lp16 writer helpers
const lp16 = (s) => { const b = Buffer.from(String(s), 'utf8'); const h = Buffer.allocUnsafe(2); h.writeUInt16LE(b.length, 0); return Buffer.concat([h, b]); };
const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(v & 0xffff, 0); return b; };
const u32 = (v) => { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const strlist = (arr) => Buffer.concat([u16(arr.length), ...arr.map(lp16)]);
const oc = (format, mask, placement, name, pre, app, empty) =>
  Buffer.concat([u8(format), u8(mask), u8(placement), lp16(name), lp16(pre), lp16(app), lp16(empty)]);

// v2 profile: GET meta = base64 cookie __cid; everything else raw body
function profileBody() {
  return Buffer.concat([
    u8(2),                 // version
    u8(0),                 // rotation sequential
    lp16('mock-nax/1.0'),  // user_agent
    lp16(BID),
    strlist(['127.0.0.1:1']),
    u16(404), lp16('nf'), strlist(['Content-Type: text/html']),
    strlist(['/api/v2/health']),            // get uris
    oc(1, 0, 2, '__cid', '', '', ''),          // get client meta: base64 cookie __cid
    strlist([]), strlist([]),
    oc(0, 0, 0, '', '', '', ''),               // get server output: raw body
    strlist([]),
    strlist(['/api/v2/events']),             // post uris
    oc(0, 0, 1, BID, '', '', ''),              // post client meta: raw header
    oc(0, 0, 0, '', '', '', ''),               // post client output: raw body
    strlist([]),
    oc(0, 0, 0, '', '', '', ''),               // post server output: raw body
    strlist([]),
  ]);
}

const sessions = new Set();
const taskCmds = new Map(); // taskId -> cmd
let taskSeq = 1;

function packTask(t) {
  const taskId = taskSeq++;
  let args = Buffer.alloc(0);
  if (t.cmd === 22 || t.cmd === 24) args = Buffer.from(t.path || '.', 'utf8');       // mkdir / cat
  if (t.cmd === 25) args = Buffer.concat([u8(0), Buffer.from(t.path || '.', 'utf8')]); // ls: flags+path
  if (t.cmd === 20) args = Buffer.from(t.path || '.', 'utf8');                          // cd
  if (t.cmd === 17) args = Buffer.concat([u32(t.ms || 5000), u8(t.jitter || 0)]);       // sleep
  taskCmds.set(taskId, t.cmd);
  return frame(T.TASK, Buffer.concat([u32(taskId), u8(t.cmd), u32(args.length), args]));
}

function drainTasks() {
  if (!TASKS_FILE || !fs.existsSync(TASKS_FILE)) return [frame(T.NO_TASKS, Buffer.alloc(0))];
  const lines = fs.readFileSync(TASKS_FILE, 'utf8').split('\n').filter((l) => l.trim());
  fs.writeFileSync(TASKS_FILE, '');
  if (!lines.length) return [frame(T.NO_TASKS, Buffer.alloc(0))];
  console.log('[nax] pushing ' + lines.length + ' task(s)');
  return lines.map((l) => packTask(JSON.parse(l)));
}

function noteResult(taskId, data) {
  const cmd = taskCmds.get(taskId);
  if (cmd === 21) return 'pwd=' + data.toString('utf8');
  if (cmd === 16) return 'whoami=' + data.toString('utf8');
  if (cmd === 22) return 'mkdir ok';
  if (cmd === 25 && data.length > 4) { const pl = data.readUInt16LE(0); return `ls entries=${data.readUInt16LE(2 + pl)}`; }
  if (cmd === 17 && data.length >= 5) return `sleep=${data.readUInt32LE(0)}ms`;
  return `cmd=${cmd} len=${data.length}`;
}

const srv = http.createServer((req, res) => {
  const sid = req.headers[BID.toLowerCase()];
  if (!sid || !/^[0-9a-f]{16}$/i.test(sid)) { res.statusCode = 404; return res.end('nf'); }

  if (req.method === 'GET') {
    const cookie = req.headers['cookie'] || '';
    const m = cookie.match(/__cid=([^;]+)/);
    if (!m) { res.statusCode = 404; return res.end('nf'); }
    try { aesDec(Buffer.from(decodeURIComponent(m[1]), 'base64'), KEY); } catch (_) { res.statusCode = 404; return res.end('nf'); }
    const out = Buffer.concat(drainTasks());
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.end(aesEnc(out, KEY));
  }

  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let plain;
      try { plain = aesDec(body, KEY); } catch (_) { res.statusCode = 404; return res.end('nf'); }
      for (const f of walkFrames(plain)) {
        if (f.type === T.REGISTER) {
          // lp16 host, lp16 user, arch u8, pid u32, sleep u32
          const hostLen = f.body.readUInt16LE(0);
          const host = f.body.subarray(2, 2 + hostLen).toString('utf8');
          sessions.add(sid);
          console.log(`[nax-reg] sid=${sid} host=${host}`);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/octet-stream');
          return res.end(aesEnc(frame(T.PROFILE, profileBody()), KEY));
        }
        if (f.type === T.RESULT && sessions.has(sid)) {
          const taskId = f.body.readUInt32LE(0);
          const status = f.body[4];
          const dlen = f.body.readUInt32LE(5);
          const data = f.body.subarray(9, 9 + dlen);
          console.log(`[nax-reply] task=${taskId} status=${status} ${noteResult(taskId, data)}`);
        }
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(aesEnc(frame(T.NO_TASKS, Buffer.alloc(0)), KEY));
    });
    return;
  }
  res.statusCode = 404;
  res.end('nf');
});
srv.listen(PORT, '127.0.0.1', () => console.log('[mock-nax] listening :' + srv.address().port));
