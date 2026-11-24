const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { createCache } = require('../lib/cache');
const { PRIORITY } = require('../lib/queue');
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const pbf = () => new Response(Buffer.from([26, 0]), { headers: { 'content-type': 'application/x-protobuf' } });
test('deduplicate one tile while isolating different providers at identical coordinates', async t => {
  const dir = await setup(t); let calls = 0;
  const cache = createCache({ fetchImpl: async () => { calls++; await new Promise(r => setTimeout(r, 5)); return pbf(); } });
  const a = { file: path.join(dir, 'qld/3/4/5.pbf'), url: 'https://example.test/qld' };
  const b = { file: path.join(dir, 'nsw/3/4/5.pbf'), url: 'https://example.test/nsw' };
  const results = await Promise.all([cache.get(a), cache.get(a), cache.get(b)]);
  assert.equal(calls, 2); assert.equal(results[0].path, results[1].path); assert.notEqual(results[0].path, results[2].path);
  assert.equal(cache.stats.peakDownloads, 2); assert.equal(cache.stats.activeDownloads, 0);
});
test('404 and 204 empty results are cached briefly, then retried', async t => {
  const dir = await setup(t);
  for (const status of [404, 204]) {
    let calls = 0;
    const cache = createCache({ emptyTTL: 1000, fetchImpl: async () => { calls++; return new Response(null, { status }); } });
    const opts = { file: path.join(dir, status + '.pbf'), url: 'https://example.test/empty' };
    assert.equal((await cache.get(opts)).empty, true); await cache.get(opts); assert.equal(calls, 1);
    await fs.utimes(opts.file, new Date(0), new Date(0));
    await cache.get(opts); assert.equal(calls, 2);
  }
});
test('temporary upstream failures never poison the cache', async t => {
  const dir = await setup(t); let calls = 0;
  const cache = createCache({ fetchImpl: async () => ++calls === 1 ? new Response('down', { status: 503 }) : pbf() });
  const opts = { file: path.join(dir, 'tile.pbf'), url: 'https://example.test/tile' };
  await assert.rejects(cache.get(opts), /503/);
  await assert.rejects(fs.stat(opts.file), { code: 'ENOENT' });
  assert.equal((await cache.get(opts)).empty, false); assert.equal(calls, 2);
});
test('reject error documents and decompress raw gzip without caching partial responses', async t => {
  const dir = await setup(t);
  const opts = { file: path.join(dir, 'tile.pbf'), url: 'https://example.test/tile' };
  const bad = createCache({ fetchImpl: async () => new Response('{"error":"not a tile"}', { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(bad.get(opts), /error document/);
  const good = createCache({ fetchImpl: async () => new Response(gzipSync(Buffer.from([26, 0]))) });
  await good.get(opts); assert.deepEqual(await fs.readFile(opts.file), Buffer.from([26, 0]));
  assert.deepEqual((await fs.readdir(dir)).sort(), ['tile.pbf']);
});
test('timeout aborts a hung request and permits a later retry', async t => {
  const dir = await setup(t); let calls = 0;
  const cache = createCache({ timeoutMs: 10, fetchImpl: (_url, { signal }) => {
    if (++calls > 1) return Promise.resolve(pbf());
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' }))));
  } });
  const opts = { file: path.join(dir, 'tile.pbf'), url: 'https://example.test/tile' };
  await assert.rejects(cache.get(opts), { status: 504 });
  assert.equal(cache.stats.activeDownloads, 0);
  await cache.get(opts); assert.equal(calls, 2);
});
test('expired positive files refresh on access even before cleanup', async t => {
  const dir = await setup(t); let calls = 0;
  const cache = createCache({ fetchImpl: async () => { calls++; return pbf(); } });
  const opts = { file: path.join(dir, 'tile.pbf'), url: 'https://example.test/tile', ttl: 1000 };
  await cache.get(opts); await fs.utimes(opts.file, new Date(0), new Date(0)); await cache.get(opts);
  assert.equal(calls, 2);
});
test('prefetch borrows idle download slots and yields promptly to foreground resources', async t => {
  const dir = await setup(t), seen = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createCache({ concurrency: 4, fetchImpl: (url, { signal }) => {
    seen.push(url);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      gate.then(() => { signal.removeEventListener('abort', onAbort); resolve(pbf()); });
    });
  } });
  t.after(() => { release(); cache.close(); });
  const background = Array.from({ length: 5 }, (_, i) => cache.get({ file: path.join(dir, `${i}.pbf`), url: `https://example.test/${i}`, priority: PRIORITY.NEIGHBOUR }));
  await until(() => cache.stats.activeDownloads === 4);
  const foreground = cache.get({ file: path.join(dir, 'requested.pbf'), url: 'https://example.test/requested' });
  await until(() => seen.includes('https://example.test/requested'));
  assert.equal(cache.stats.activeDownloads, 4);
  assert.equal(cache.stats.yielded, 1);
  release(); await Promise.all([...background, foreground]);
  assert.ok(cache.stats.peakDownloads <= 4); assert.equal(cache.stats.errors, 0);
});

const { createWorkOwner } = require('../lib/work-owner');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'condition did not become true');
}
test('obsolete downloads leave both the waiting queue and network without counting as upstream errors', async t => {
  const dir = await setup(t), signals = [], owner = createWorkOwner(PRIORITY.ZOOM);
  const cache = createCache({ concurrency: 1, fetchImpl: (_url, { signal }) => {
    signals.push(signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  t.after(() => cache.close());
  const jobs = Array.from({ length: 6 }, (_, i) => assert.rejects(cache.get({ file: path.join(dir, `${i}.pbf`), url: `https://example.test/${i}`, owner }), { status: 503 }));
  await until(() => cache.stats.downloads.queued === 5);
  owner.cancel(Object.assign(new Error('old view'), { status: 503 })); await Promise.all(jobs); await tick();
  assert.equal(cache.stats.downloads.queued, 0); assert.equal(cache.stats.activeDownloads, 0);
  assert.equal(signals.length, 1); assert.equal(signals[0].aborted, true);
  assert.equal(cache.stats.errors, 0); assert.equal(cache.stats.cancelled, 6);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('cancelling one owner preserves a resource shared with another consumer', async t => {
  const dir = await setup(t), background = createWorkOwner(PRIORITY.ZOOM), request = createWorkOwner(PRIORITY.REQUEST);
  let release, signal, calls = 0;
  const cache = createCache({ fetchImpl: (_url, opts) => { calls++; signal = opts.signal; return new Promise(resolve => { release = () => resolve(pbf()); }); } });
  t.after(() => cache.close());
  const opts = { file: path.join(dir, 'shared.pbf'), url: 'https://example.test/shared' };
  const obsolete = assert.rejects(cache.get({ ...opts, owner: background }), { status: 503 });
  const required = cache.get({ ...opts, owner: request }); await until(() => !!release);
  background.cancel(Object.assign(new Error('old view'), { status: 503 })); await obsolete;
  assert.equal(signal.aborted, false); release(); await required;
  assert.equal(calls, 1); assert.equal(cache.stats.cancelled, 0);
});

test('render promotion promotes resources already queued, ahead of other prefetch', async t => {
  const dir = await setup(t), seen = [], releases = [], owner = createWorkOwner(PRIORITY.ZOOM);
  const cache = createCache({ concurrency: 1, fetchImpl: url => new Promise(resolve => { seen.push(url); releases.push(() => resolve(pbf())); }) });
  t.after(() => cache.close());
  const get = (name, more = {}) => cache.get({ file: path.join(dir, name), url: 'https://example.test/' + name, ...more });
  const blocker = get('blocker'); await until(() => seen.length === 1);
  const neighbour = get('nearby', { priority: PRIORITY.NEIGHBOUR });
  const promoted = get('promoted', { owner }); await until(() => cache.stats.downloads.queued === 2);
  owner.promote(PRIORITY.REQUEST);
  assert.equal(cache.stats.downloads.queuedByPriority.requested, 1);
  releases.shift()(); await blocker; await until(() => seen.length === 2);
  assert.equal(seen[1], 'https://example.test/promoted');
  releases.shift()(); await promoted; await until(() => releases.length === 1);
  releases.shift()(); await neighbour;
});

test('promoting a render does not interrupt its other active resources during listener updates', async t => {
  const dir = await setup(t), owner = createWorkOwner(PRIORITY.ZOOM), releases = [], signals = [];
  const cache = createCache({ concurrency: 2, fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal); releases.push(() => resolve(pbf()));
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  t.after(() => cache.close());
  const get = i => cache.get({ file: path.join(dir, `${i}.pbf`), url: `https://example.test/${i}`, owner });
  const jobs = [get(1), get(2), get(3)]; await until(() => cache.stats.downloads.queued === 1);
  owner.promote(PRIORITY.REQUEST);
  assert.equal(cache.stats.yielded, 0); assert.ok(signals.every(signal => !signal.aborted));
  while (releases.length) releases.shift()();
  await until(() => releases.length === 1); releases.shift()(); await Promise.all(jobs);
});
