const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
async function start(t, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-start-'));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  const fixture = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.DISPLAY_TEST_ROOT, mode = process.env.DISPLAY_TEST_MODE;
const role = path.basename(process.argv[1]);
if (role === 'timeout') {
  const args = process.argv.slice(2);
  if (args[0] !== '--kill-after=1s' || args[1] !== '3s' || args[2] !== 'xdpyinfo') {
    console.error('Unexpected display timeout arguments: ' + args.join(' '));
    process.exit(98);
  }
  const result = require('node:child_process').spawnSync(args[2], args.slice(3), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (role === 'xdpyinfo') {
  let status = mode === 'unreachable' || fs.existsSync(root + '/unresponsive') ? 1 : 0;
  if (mode === 'startup-timeout') status = 124;
  if (fs.existsSync(root + '/probe-sequence')) {
    const sequence = JSON.parse(fs.readFileSync(root + '/probe-sequence', 'utf8'));
    if (sequence.length) status = sequence.shift();
    fs.writeFileSync(root + '/probe-sequence', JSON.stringify(sequence));
  }
  if (status === 1) console.error('fixture display unavailable');
  process.exit(status);
} else if (role === 'sleep') {
  const delay = process.argv[2];
  if (delay !== '2' && delay !== '0.1') process.exit(98);
  // Accelerate the supervision loop without adding production timing options.
  setTimeout(() => process.exit(0), 100);
} else if (role === 'Xvfb') {
  fs.writeFileSync(root + '/xvfb.pid', String(process.pid));
  if (mode === 'startup-failure') process.exit(2);
  if (!process.argv.includes('-displayfd') || !process.argv.includes('-nolisten')) process.exit(3);
  fs.writeSync(3, '42\\n');
  setInterval(() => {}, 1000);
} else if (role === 'node') {
  fs.writeFileSync(root + '/app.pid', String(process.pid));
  fs.writeFileSync(root + '/display', process.env.DISPLAY);
  process.on('SIGTERM', () => {
    const stop = () => { fs.writeFileSync(root + '/app-stopped', 'yes'); process.exit(0); };
    if (mode === 'graceful-stop') setTimeout(stop, 350);
    else stop();
  });
  if (mode === 'app-failure') setTimeout(() => process.exit(7), 20);
  setInterval(() => {}, 1000);
}
`;
  for (const name of ['Xvfb', 'xdpyinfo', 'timeout', 'sleep', 'node']) await fs.writeFile(path.join(bin, name), fixture, { mode: 0o755 });
  const child = spawn('/bin/bash', [path.join(__dirname, '../start.sh')], {
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, PUID: '', PGID: '',
      DATA_DIR: root, VECTOR_DIR: root + '/vector', RASTER_DIR: root + '/raster', STYLE_DIR: root + '/styles', MESA_SHADER_CACHE_DIR: root + '/mesa',
      DISPLAY: ':99', DISPLAY_TEST_ROOT: root, DISPLAY_TEST_MODE: mode },
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const done = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await done;
    for (const file of ['app.pid', 'xvfb.pid']) {
      try { process.kill(Number(await fs.readFile(path.join(root, file), 'utf8')), 'SIGTERM'); } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  async function waitFor(file) {
    for (let i = 0; i < 200; i++) {
      try { return await fs.readFile(path.join(root, file), 'utf8'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Missing fixture file ' + file + ': ' + output);
  }
  async function waitForOutput(pattern) {
    for (let i = 0; i < 500; i++) {
      if (pattern.test(output)) return;
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Missing output ' + pattern + ': ' + output);
  }
  async function probes(statuses) {
    await fs.writeFile(root + '/probe-sequence.next', JSON.stringify(statuses));
    await fs.rename(root + '/probe-sequence.next', root + '/probe-sequence');
  }
  return { child, done, root, waitFor, waitForOutput, probes, get output() { return output; } };
}
for (const [mode, diagnostic] of [
  ['startup-failure', /Xvfb process exited \(status 2\)/],
  ['unreachable', /display probe exited with status 1/],
  ['startup-timeout', /display probe timed out after 3s \(status 124\)/],
]) test('do not start HTTP server when display is ' + mode, { timeout: 10000 }, async t => {
  const s = await start(t, mode);
  assert.equal((await s.done)[0], 1);
  assert.match(s.output, diagnostic);
  assert.doesNotMatch(s.output, /check failed \(2\/3\)/, 'startup must fail without runtime retries');
  await assert.rejects(fs.access(s.root + '/app.pid'), { code: 'ENOENT' });
});
test('container shutdown waits for the application to flush retained preparation state', { timeout: 10000 }, async t => {
  const s = await start(t, 'graceful-stop');
  await s.waitFor('display');
  s.child.kill('SIGTERM');
  assert.equal((await s.done)[0], 0);
  assert.equal(await fs.readFile(s.root + '/app-stopped', 'utf8'), 'yes');
});
test('stop the server immediately when the running display process exits', { timeout: 10000 }, async t => {
  const s = await start(t, 'healthy');
  assert.equal(await s.waitFor('display'), ':42', 'use the display selected by the new X server');
  process.kill(Number(await s.waitFor('xvfb.pid')), 'SIGTERM');
  assert.equal((await s.done)[0], 1);
  assert.match(s.output, /Xvfb process exited \(status 143\)/);
  assert.match(s.output, /Xvfb :42 failed/);
  assert.doesNotMatch(s.output, /check failed \(2\/3\)/, 'a dead display must not use the probe retry allowance');
  assert.equal(await s.waitFor('app-stopped'), 'yes');
});
test('stop the server after three consecutive display probe failures', { timeout: 10000 }, async t => {
  const s = await start(t, 'healthy');
  await s.waitFor('display');
  await fs.writeFile(s.root + '/unresponsive', 'yes');
  assert.equal((await s.done)[0], 1);
  for (let attempt = 1; attempt <= 3; attempt++) assert.ok(s.output.includes(`check failed (${attempt}/3)`), s.output);
  assert.match(s.output, /display probe exited with status 1/);
  assert.match(s.output, /fixture display unavailable/, 'retain the probe error detail');
  assert.match(s.output, /Xvfb :42 failed; stopping the server so the container can restart/);
  assert.equal(await s.waitFor('app-stopped'), 'yes');
});
test('keep serving after isolated probe failures and reset the consecutive failure count on recovery', { timeout: 10000 }, async t => {
  const s = await start(t, 'healthy');
  await s.waitFor('display');
  await s.probes([1, 0, 1, 1, 0]);
  await s.waitForOutput(/connection recovered after 1 failed check\(s\)/);
  assert.equal(s.child.exitCode, null);
  await s.waitForOutput(/connection recovered after 2 failed check\(s\)/);
  assert.equal(s.child.exitCode, null);
  assert.equal((s.output.match(/check failed \(1\/3\)/g) || []).length, 2, 'recovery resets the failure count');
  assert.doesNotMatch(s.output, /check failed \(3\/3\)|Xvfb :42 failed/);
  await assert.rejects(fs.access(s.root + '/app-stopped'), { code: 'ENOENT' });
});
for (const [status, diagnostic] of [
  [124, /display probe timed out after 3s \(status 124\)/],
  [137, /display probe was killed \(status 137; timeout kill-after limit 1s\)/],
]) test('diagnose display probe status ' + status + ' and recover', { timeout: 10000 }, async t => {
  const s = await start(t, 'healthy');
  await s.waitFor('display');
  await s.probes([status, 0]);
  await s.waitForOutput(/connection recovered after 1 failed check\(s\)/);
  assert.match(s.output, diagnostic);
  assert.match(s.output, /check failed \(1\/3\)/);
  assert.equal(s.child.exitCode, null);
  await assert.rejects(fs.access(s.root + '/app-stopped'), { code: 'ENOENT' });
});
test('preserve application failure exit code and stop the display', { timeout: 10000 }, async t => {
  const s = await start(t, 'app-failure');
  assert.equal((await s.done)[0], 7);
  assert.match(s.output, /Xvfb ready on :42/);
});
