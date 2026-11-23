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
  const result = require('node:child_process').spawnSync(process.argv[3], process.argv.slice(4), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (role === 'xdpyinfo') {
  process.exit(mode === 'unreachable' || fs.existsSync(root + '/unresponsive') ? 1 : 0);
} else if (role === 'Xvfb') {
  fs.writeFileSync(root + '/xvfb.pid', String(process.pid));
  if (mode === 'startup-failure') process.exit(2);
  if (!process.argv.includes('-displayfd') || !process.argv.includes('-nolisten')) process.exit(3);
  fs.writeSync(3, '42\\n');
  setInterval(() => {}, 1000);
} else if (role === 'node') {
  fs.writeFileSync(root + '/app.pid', String(process.pid));
  fs.writeFileSync(root + '/display', process.env.DISPLAY);
  process.on('SIGTERM', () => { fs.writeFileSync(root + '/app-stopped', 'yes'); process.exit(0); });
  if (mode === 'app-failure') setTimeout(() => process.exit(7), 20);
  setInterval(() => {}, 1000);
}
`;
  for (const name of ['Xvfb', 'xdpyinfo', 'timeout', 'node']) await fs.writeFile(path.join(bin, name), fixture, { mode: 0o755 });
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
  return { child, done, root, waitFor, get output() { return output; } };
}
for (const mode of ['startup-failure', 'unreachable']) test('do not start HTTP server when display is ' + mode, { timeout: 10000 }, async t => {
  const s = await start(t, mode);
  assert.equal((await s.done)[0], 1);
  assert.match(s.output, /\[DISPLAY\]/);
  await assert.rejects(fs.access(s.root + '/app.pid'), { code: 'ENOENT' });
});
for (const failure of ['exited', 'unresponsive']) test('stop the server if the running display becomes ' + failure, { timeout: 10000 }, async t => {
  const s = await start(t, 'healthy');
  assert.equal(await s.waitFor('display'), ':42', 'use the display selected by the new X server');
  if (failure === 'exited') process.kill(Number(await s.waitFor('xvfb.pid')), 'SIGTERM');
  else await fs.writeFile(s.root + '/unresponsive', 'yes');
  assert.equal((await s.done)[0], 1);
  assert.match(s.output, /Xvfb :42 failed/);
  assert.equal(await s.waitFor('app-stopped'), 'yes');
});
test('preserve application failure exit code and stop the display', { timeout: 10000 }, async t => {
  const s = await start(t, 'app-failure');
  assert.equal((await s.done)[0], 7);
  assert.match(s.output, /Xvfb ready on :42/);
});
