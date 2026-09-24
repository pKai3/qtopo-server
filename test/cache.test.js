const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { createCache } = require('../lib/cache');
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
  await cache.get(opts); assert.equal(calls, 2);
});
test('expired positive files refresh on access even before cleanup', async t => {
  const dir = await setup(t); let calls = 0;
  const cache = createCache({ fetchImpl: async () => { calls++; return pbf(); } });
  const opts = { file: path.join(dir, 'tile.pbf'), url: 'https://example.test/tile', ttl: 1000 };
  await cache.get(opts); await fs.utimes(opts.file, new Date(0), new Date(0)); await cache.get(opts);
  assert.equal(calls, 2);
});
