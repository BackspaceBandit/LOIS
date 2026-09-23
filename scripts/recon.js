#!/usr/bin/env node
// recon.js — Electron target assessment (ticket 013). Read-only.
//
// Answers, for an arbitrary install directory:
//   1. is it Electron at all (resources/ + fuse sentinel in the main binary)
//   2. fuse bitstring (runAsNode / asarIntegrity / onlyLoadAppFromAsar / ...)
//   3. recommended injection route (inject_asar repack | inject_unpacked
//      script-jack | loose-file jack | NOT injectable with current tooling)
//   4. layout notes (Squirrel/NSIS/MSIX-flavored, autostart story)
//
// Fuse wire format (empirical, VS Code 1.139 / GHD 3.6.6, Electron ~37):
//   ...sentinel(32B ascii) | version:u8 | length:u8 | "<length>" ascii '0'/'1'
// Fuse bit order (Electron fuses.h, stable v12+):
//   0 runAsNode  1 enableCookieEncryption  2 enableNodeOptionsEnvironmentVariable
//   3 enableNodeCliInspectArguments        4 enableEmbeddedAsarIntegrityValidation
//   5 onlyLoadAppFromAsar                  6 loadBrowserProcessSpecificV8Snapshot
//   7 grantFileProtocolExtraPrivileges     8+ newer (reported raw)
//
// Usage: node scripts/recon.js --app <install-dir> [--exe <binary>] [--write docs/targets/<name>.md]
const fs = require('fs');
const path = require('path');

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const FUSE_KEYS = [
  'runAsNode', 'enableCookieEncryption', 'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments', 'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar', 'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
];

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const die = (m) => { console.error('[recon] ' + m); process.exit(1); };

// chunked sentinel scan (binaries are 100-300 MB; don't slurp)
function findSentinel(file) {
  const needle = Buffer.from(SENTINEL, 'ascii');
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const CHUNK = 32 << 20, OVER = 64;
    let off = 0, carry = Buffer.alloc(0);
    while (off < size) {
      const want = Math.min(CHUNK, size - off);
      const buf = Buffer.allocUnsafe(want);
      fs.readSync(fd, buf, 0, want, off);
      const win = Buffer.concat([carry, buf]);
      const at = win.indexOf(needle);
      if (at >= 0) return off - carry.length + at;
      carry = win.subarray(win.length - OVER);
      off += want;
    }
    return -1;
  } finally { fs.closeSync(fd); }
}

function readFuses(exePath) {
  const at = findSentinel(exePath);
  if (at < 0) return null;
  const fd = fs.openSync(exePath, 'r');
  try {
    const head = Buffer.allocUnsafe(2);
    fs.readSync(fd, head, 0, 2, at + 32);
    const version = head[0], len = head[1];
    if (len < 4 || len > 32) return { version, parse_error: `implausible fuse length ${len}` };
    const bits = Buffer.allocUnsafe(len);
    fs.readSync(fd, bits, 0, len, at + 34);
    const bitstr = bits.toString('ascii');
    if (!/^[01]+$/.test(bitstr)) return { version, parse_error: 'fuse bits not a 0/1 string' };
    const fuses = {};
    for (let i = 0; i < bitstr.length; i++) fuses[FUSE_KEYS[i] || `unknown_${i}`] = bitstr[i] === '1';
    return { version, bits: bitstr, fuses };
  } finally { fs.closeSync(fd); }
}

function findMainExe(appDir) {
  // top level first, then one level down (MSIX-style hash dirs)
  const cands = [];
  const pushDir = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try { if (fs.statSync(p).isFile() && /\.exe$/i.test(f)) cands.push(p); } catch (_) {}
    }
  };
  pushDir(appDir);
  for (const f of fs.readdirSync(appDir)) {
    const p = path.join(appDir, f);
    try { if (fs.statSync(p).isDirectory()) pushDir(p); } catch (_) {}
  }
  if (!cands.length) return null;
  cands.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size); // biggest = the Electron binary
  return cands[0];
}

function findResources(appDir) {
  const cands = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          if (f === 'resources') cands.push(p);
          else walk(p, depth + 1);
        }
      } catch (_) {}
    }
  };
  walk(appDir, 0);
  // prefer the resources dir that actually has an app payload
  cands.sort((a, b) => score(b) - score(a));
  return cands[0] || null;

  function score(r) {
    let s = 0;
    if (fs.existsSync(path.join(r, 'app.asar'))) s += 4;
    if (fs.existsSync(path.join(r, 'app', 'package.json'))) s += 4;
    if (fs.existsSync(path.join(r, 'app.asar.unpacked'))) s += 1;
    return s;
  }
}

function readAppManifest(resourcesDir) {
  // loose first
  const loose = path.join(resourcesDir, 'app', 'package.json');
  if (fs.existsSync(loose)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(loose, 'utf8'));
      return { layout: 'loose', pkg, mainPath: path.join(resourcesDir, 'app', String(pkg.main || 'index.js').replace(/^\.\//, '')) };
    } catch (_) {}
  }
  const asar = path.join(resourcesDir, 'app.asar');
  if (fs.existsSync(asar)) {
    try {
      const { readArchive, readFileBytes } = require('./asar');
      const arch = readArchive(asar);
      const pkgEntry = arch.header.files['package.json'];
      if (!pkgEntry) return { layout: 'asar', pkg: null, note: 'no package.json in archive' };
      const pkg = JSON.parse(readFileBytes(asar, arch, pkgEntry).toString('utf8'));
      return { layout: 'asar', pkg };
    } catch (e) { return { layout: 'asar', pkg: null, note: 'asar parse failed: ' + e.message }; }
  }
  return null;
}

function detectModuleType(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 65536);
    // ESM markers incl. minified forms: `import{...}from"..."`, `import"..."`,
    // `export{...}`, `import.meta`
    if (/\bimport\s*[{*"']|\bimport\s+[\w$]+\s*from|import\.meta|\bexport\s*\{|\bexport\s+default/.test(head)) return 'ESM';
    if (head.includes('require(') || head.includes('module.exports')) return 'CJS';
  } catch (_) {}
  return 'unknown';
}

function listUnpackedJs(resourcesDir) {
  const dir = path.join(resourcesDir, 'app.asar.unpacked');
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (f.endsWith('.js')) out.push(path.relative(resourcesDir, p));
      } catch (_) {}
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  out.sort((a, b) => (b.includes('bindings') ? 1 : 0) - (a.includes('bindings') ? 1 : 0));
  return out;
}

function main() {
  const appDir = arg('app', null) || die('usage: recon.js --app <install-dir> [--exe <binary>] [--write <md>]');
  if (!fs.existsSync(appDir)) die('not found: ' + appDir);

  const r = { appDir, electron: false };
  const exe = arg('exe', null) || findMainExe(appDir);
  if (!exe) {
    console.log('== recon:', appDir);
    console.log('electron     : NO (no .exe found)');
    console.log('ROUTE        : NOT-ELECTRON — out of LOIS scope (use the HOI.SIN path for native targets)');
    return;
  }
  r.exe = { path: exe, size: fs.statSync(exe).size };

  const fuseInfo = readFuses(exe);
  r.fuses = fuseInfo;
  const resourcesDir = findResources(appDir);
  r.resourcesDir = resourcesDir;
  const manifest = resourcesDir ? readAppManifest(resourcesDir) : null;
  r.manifest = manifest && { layout: manifest.layout, name: manifest.pkg && manifest.pkg.name, version: manifest.pkg && manifest.pkg.version, main: manifest.pkg && manifest.pkg.main };

  r.electron = !!(fuseInfo && resourcesDir && manifest);

  // route decision
  const f = (fuseInfo && fuseInfo.fuses) || {};
  const unpackedJs = resourcesDir ? listUnpackedJs(resourcesDir) : [];
  r.unpackedJsCandidates = unpackedJs.slice(0, 5);
  if (!r.electron) {
    r.route = 'NOT-ELECTRON';
    r.note = 'no fuse sentinel and/or no resources payload — out of LOIS scope (use the HOI.SIN path for native targets)';
  } else if (manifest.layout === 'loose' && f.onlyLoadAppFromAsar === false) {
    r.route = 'inject_unpacked (loose-file jack)';
    const mainRel = String(r.manifest.main || 'index.js').replace(/^\.\//, '');
    const mt = detectModuleType(path.join(resourcesDir, 'app', mainRel));
    r.note = `--target app/${mainRel} — main is ${mt}${mt === 'ESM' ? ' (require() hook would no-op; import() hook OK)' : ''}`;
  } else if (manifest.layout === 'asar' && f.enableEmbeddedAsarIntegrityValidation === false) {
    r.route = 'inject_asar (repack)';
    r.note = 'integrity validation off — repack tolerated';
  } else if (manifest.layout === 'asar' && f.onlyLoadAppFromAsar === false && unpackedJs.length) {
    r.route = 'inject_unpacked (unpacked script-jack)';
    r.note = `hook target candidate: ${unpackedJs[0]}`;
  } else if (manifest.layout === 'asar') {
    r.route = 'NOT-INJECTABLE';
    r.note = 'asar integrity on AND onlyLoadAppFromAsar on (or no unpacked JS) — current tooling cannot hook this build';
  } else {
    r.route = 'REVIEW-MANUALLY';
    r.note = 'loose layout but onlyLoadAppFromAsar=1, or mixed signals';
  }

  // updater story (drives re-injection cadence — ticket 007)
  const rootEntries = fs.readdirSync(appDir);
  r.updater = rootEntries.includes('Update.exe') ? 'squirrel (whole-dir replace on update)'
    : rootEntries.some((f) => /^unins\d+\.exe$/i.test(f)) ? 'nsis (in-place rewrite)'
    : /^[0-9a-f]{10}$/.test(path.basename(resourcesDir ? path.dirname(resourcesDir) : '')) ? 'msix-style (hash subdir)'
    : 'unknown';

  // report
  console.log('== recon:', appDir);
  console.log('electron     :', r.electron ? 'yes' : 'NO');
  console.log('exe          :', r.exe.path, `(${(r.exe.size / 1048576).toFixed(1)} MB)`);
  if (fuseInfo) console.log('fuses        :', fuseInfo.bits, JSON.stringify(fuseInfo.fuses));
  else console.log('fuses        : sentinel not found');
  if (r.manifest) console.log('app          :', `${r.manifest.name || '?'}@${r.manifest.version || '?'}`, `(${r.manifest.layout}, main=${r.manifest.main})`);
  console.log('updater      :', r.updater);
  console.log('ROUTE        :', r.route, '—', r.note);
  if (r.unpackedJsCandidates.length) console.log('unpacked js  :', r.unpackedJsCandidates.join(' | '));

  const out = arg('write', null);
  if (out) {
    const md = `# Target profile: ${path.basename(appDir)}\n\n(recon stub ${new Date().toISOString().slice(0, 10)} — verify by hand before ops)\n\n- exe: \`${r.exe.path}\`\n- fuses: \`${fuseInfo ? fuseInfo.bits : 'n/a'}\`\n- app: ${r.manifest ? `${r.manifest.name}@${r.manifest.version} (${r.manifest.layout}, main=${r.manifest.main})` : 'n/a'}\n- updater: ${r.updater}\n- route: **${r.route}** — ${r.note}\n`;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md);
    console.log('written      :', out);
  }
}

if (require.main === module) main();
module.exports = { readFuses, findSentinel, SENTINEL };
