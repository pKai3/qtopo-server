const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRenderer } = require('../lib/render');
const { createCacheFiles } = require('../lib/cache-files');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-consumers-'));
  let blocked = true;
  const files = createCacheFiles();
  const renderer = createRenderer({ renderConcurrency: 1, renderQueueLimit: 4, rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 2000 },
    path.join(__dirname, 'fixtures/render-worker.js'), undefined, {
      read: () => ({ limitBytes: 2048 * 1024 ** 2, currentBytes: (blocked ? 1800 : 64) * 1024 ** 2, workingBytes: (blocked ? 1800 : 64) * 1024 ** 2 }),
    }, files);
  t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, renderer, files, allow: () => { blocked = false; } };
}
const interest = signal => ({ key: 'same-client-and-tile', score: () => 2, signal });
const abandon = controller => controller.abort(Object.assign(new Error('disconnected'), { status: 499 }));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('render condition did not settle');
}

test('disconnecting one of two requests for the same tile preserves the surviving request', async t => {
  const { root, renderer, allow } = await setup(t);
  const a = new AbortController(), b = new AbortController(), job = { outPath: path.join(root, 'tile.png') };
  const first = renderer.render(job, interest(a.signal));
  const second = renderer.render({ ...job }, interest(b.signal));
  abandon(a); await assert.rejects(first, { status: 499 });
  assert.equal(renderer.stats.queued, 1); assert.equal(renderer.stats.cancelledQueued, 0);
  allow(); await second;
  assert.equal(await fs.readFile(job.outPath, 'utf8'), 'rendered-test-output');
});

test('a surviving sibling tile protects the shared metatile after another request times out', async t => {
  const { root, renderer, allow } = await setup(t);
  const outputs = [0, 1].map(i => ({ outPath: path.join(root, `${i}.png`) }));
  const a = new AbortController(), b = new AbortController();
  const first = renderer.render({ renderKey: 'grid', outputs, outPath: outputs[0].outPath }, interest(a.signal));
  const second = renderer.render({ renderKey: 'grid', outputs, outPath: outputs[1].outPath }, interest(b.signal));
  a.abort(Object.assign(new Error('deadline'), { status: 504 })); await assert.rejects(first, { status: 504 });
  assert.equal(renderer.stats.queued, 1);
  allow(); await second;
  assert.equal(renderer.stats.spawned, 1);
});

test('the last disconnected queued request releases its slot and an immediate retry is independent', async t => {
  const { root, renderer, allow } = await setup(t);
  const a = new AbortController(), b = new AbortController(), job = { outPath: path.join(root, 'tile.png') };
  const first = renderer.render(job, interest(a.signal));
  abandon(a);
  const retry = renderer.render({ ...job }, interest(b.signal));
  await assert.rejects(first, { status: 499 });
  assert.equal(renderer.stats.cancelledQueued, 1); assert.equal(renderer.stats.queued, 1);
  allow(); await retry;
  assert.equal(renderer.stats.spawned, 1);
});

test('disconnecting all clients lets an already running render finish and keeps its files protected', async t => {
  const { root, renderer, files, allow } = await setup(t);
  allow();
  const a = new AbortController(), job = { outPath: path.join(root, 'tile.png'), gate: path.join(root, 'go'), recordPid: path.join(root, 'pid') };
  const pending = renderer.render(job, interest(a.signal));
  await until(() => fs.access(job.recordPid).then(() => true, () => false));
  abandon(a); await assert.rejects(pending, { status: 499 });
  assert.equal(renderer.stats.active, 1);
  assert.equal(await files.evict(job.outPath, () => assert.fail('active output must stay protected')), false);
  await fs.writeFile(job.gate, 'go');
  await until(() => renderer.stats.completed === 1 && renderer.stats.active === 0);
  assert.equal(await fs.readFile(job.outPath, 'utf8'), 'rendered-test-output');
});

test('a cancelled foreground subscription does not discard an existing prefetch commitment', async t => {
  const { root, renderer, allow } = await setup(t);
  const job = { outPath: path.join(root, 'tile.png'), priority: 1 };
  const prefetch = renderer.render(job);
  const a = new AbortController();
  const requested = renderer.render({ ...job, priority: 0 }, interest(a.signal));
  abandon(a); await assert.rejects(requested, { status: 499 });
  assert.equal(renderer.stats.queued, 1);
  allow(); await prefetch;
});
