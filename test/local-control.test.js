const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { listenControl, requestControl } = require('../lib/local-control');
const { main } = require('../scripts/admin');

test('CLI listener is a private Unix socket, preserves active listeners and refuses ordinary files', async t => {
  const dir = await fs.mkdtemp('/tmp/qtopo-local-test-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const socket = path.join(dir, 'control.sock');
  const server = await listenControl({ stats: { clearing: { phase: 'idle' } } }, socket);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal(typeof server.address(), 'string', 'there must be no network address or TCP port');
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(socket)).mode & 0o777, 0o600);
  await assert.rejects(listenControl({}, socket), /already running/);
  assert.equal((await requestControl('/status', undefined, socket)).clearing.phase, 'idle');
  const file = path.join(dir, 'keep.txt');
  await fs.writeFile(file, 'keep');
  await assert.rejects(listenControl({}, file), /Unsafe local control socket/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test('CLI requires explicit cache confirmation and cannot target another server', async () => {
  await assert.rejects(main(['clear-cache']), /missing --confirm/);
  await assert.rejects(main(['test', '--url', 'https://elsewhere.example']), /not supported/);
  await assert.rejects(main(['test', '--concurrency', '9999']), /concurrency/);
});
