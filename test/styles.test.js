const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
const { createProviders } = require('../lib/providers');
const { seedStyles, getStyle, styleRevision, createStyleCache } = require('../lib/styles');
test('reuse prepared styles, preserve existing cache keys, and isolate NSW zoom variants', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-styles-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ DATA_DIR: dir }), providers = createProviders(config);
  await seedStyles(config, providers);
  const cache = createStyleCache(config);
  for (const provider of Object.values(providers)) {
    const [a, b] = await Promise.all([cache.get(provider), cache.get(provider)]);
    assert.equal(a, b);
    assert.equal(a.revision, styleRevision(await getStyle(config, provider), config, provider));
    assert.equal(a.revision, styleRevision(a.style, { ...config, pngCompression: 6 }, provider), 'lossless compression does not invalidate existing pixels');
  }
  const nsw = await cache.get(providers.nsw), original = JSON.stringify(nsw.style);
  const sixteen = nsw.atZoom(16), twelve = nsw.atZoom(12);
  assert.equal(sixteen, nsw.atZoom(16)); assert.notEqual(sixteen.revision, twelve.revision);
  const oldStyle = structuredClone(nsw.style);
  for (const source of Object.values(oldStyle.sources)) if (source.type === 'vector') source.maxzoom = Math.min(source.maxzoom, 16);
  assert.equal(sixteen.revision, styleRevision(oldStyle, config, providers.nsw));
  assert.equal(JSON.stringify(nsw.style), original);
  assert.deepEqual(nsw.atZoom(null).style, { version: 8, sources: {}, layers: [] });
  assert.equal(cache.stats.loads, 3);

  const edited = JSON.parse(await fs.readFile(providers.nsw.stylePath));
  edited.layers.push({ id: 'test-background', type: 'background' });
  await fs.writeFile(providers.nsw.stylePath, JSON.stringify(edited));
  const fresh = await cache.get(providers.nsw);
  assert.notEqual(fresh.revision, nsw.revision); assert.notEqual(fresh.atZoom(16).revision, sixteen.revision);
  await fs.writeFile(providers.nsw.stylePath, '{invalid');
  await assert.rejects(cache.get(providers.nsw), SyntaxError);
  await fs.writeFile(providers.nsw.stylePath, JSON.stringify(edited));
  assert.equal((await cache.get(providers.nsw)).revision, fresh.revision);
});
