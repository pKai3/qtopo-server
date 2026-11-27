const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
const { createProviders } = require('../lib/providers');
const { seedStyles, getStyle, styleRevision, createStyleCache } = require('../lib/styles');
const { getProfile, NSW_CONTOUR_SOURCE } = require('../lib/profiles');
const { validateStyleMin, featureFilter } = require('@maplibre/maplibre-gl-style-spec');
test('reuse prepared styles, revision raster settings, and isolate NSW zoom variants', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-styles-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ DATA_DIR: dir }), providers = createProviders(config);
  await seedStyles(config, providers);
  const cache = createStyleCache(config);
  for (const provider of Object.values(providers)) {
    const [a, b] = await Promise.all([cache.get(provider), cache.get(provider)]);
    assert.equal(a, b);
    assert.equal(a.revision, styleRevision(await getStyle(config, provider), config, provider));
    assert.deepEqual(a.atZoom(null).style, { version: 8, sources: {}, layers: [] }, 'existing providers keep their absent-coverage behavior');
    assert.equal(a.revision, styleRevision(a.style, { ...config, pngCompression: 6 }, provider), 'lossless compression does not invalidate existing pixels');
    if (provider.type === 'vector') {
      assert.notEqual(a.revision, styleRevision(a.style, { ...config, metatileSize: 1 }, provider));
      assert.notEqual(a.revision, styleRevision(a.style, { ...config, renderBufferPx: 0 }, provider));
    }
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

function contourDataset(character = 'a') {
  const revision = character.repeat(64);
  return { revision, tiles: `/contours/nsw/${revision}/{z}/{x}/{y}.pbf`, bounds: [140.99, -37.6, 159.3, -28.15],
    minzoom: 10, maxzoom: 16, attribution: '© State of New South Wales · CC BY 3.0 AU' };
}
async function contourSetup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-contour-style-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ DATA_DIR: dir }), providers = createProviders(config);
  await seedStyles(config, providers);
  return { config, providers, cache: createStyleCache(config), profile: { ...getProfile('nsw-2m'), token: 'same-token', contourDataset: contourDataset() } };
}
const legacyContour = layer => ['Contours', 'Contours/label'].includes(layer['source-layer']);

test('2 m style replaces both legacy contour layers at their drawing positions and preserves the rest', async t => {
  const { providers, cache, profile } = await contourSetup(t);
  const readable = (await cache.get(providers.nsw, 'readable')).style;
  const before = structuredClone(readable), prepared = await cache.get(providers.nsw, profile);
  assert.deepEqual(validateStyleMin(prepared.style), []);
  assert.deepEqual(prepared.style.layers.filter(layer => layer.source !== NSW_CONTOUR_SOURCE), readable.layers.filter(layer => !legacyContour(layer)));
  assert.ok(!prepared.style.layers.some(legacyContour), 'neither old linework nor old labels remain');
  for (const key of ['glyphs', 'sprite']) assert.deepEqual(prepared.style[key], readable[key]);
  assert.deepEqual(prepared.style.sources.esri, readable.sources.esri);
  assert.equal(prepared.style.layers.findIndex(layer => layer.id === `${NSW_CONTOUR_SOURCE}-50m`), readable.layers.findIndex(layer => layer['source-layer'] === 'Contours'));
  const preceding = (layers, predicate) => layers.slice(0, layers.findIndex(predicate)).filter(layer => layer.source !== NSW_CONTOUR_SOURCE && !legacyContour(layer));
  assert.deepEqual(preceding(prepared.style.layers, layer => layer.id === `${NSW_CONTOUR_SOURCE}-50m-label`), preceding(readable.layers, layer => layer['source-layer'] === 'Contours/label'));
  assert.deepEqual(readable, before, 'the existing prepared style is not mutated');
  assert.deepEqual(prepared.style.sources[NSW_CONTOUR_SOURCE].tiles, [profile.contourDataset.tiles]);

  const added = prepared.style.layers.filter(layer => layer.source === NSW_CONTOUR_SOURCE);
  assert.deepEqual(added.map(layer => [layer.type, layer.minzoom]), [['line', 10], ['line', 12], ['line', 15], ['symbol', 12], ['symbol', 16]]);
  const drawn = elevation => added.filter((layer, i) => featureFilter(layer.filter, `layers[${i}].filter`).filter({ zoom: 18 }, { type: 2, properties: { elevation } })).map(layer => layer.id);
  assert.deepEqual(drawn(100), [`${NSW_CONTOUR_SOURCE}-50m`, `${NSW_CONTOUR_SOURCE}-50m-label`]);
  assert.deepEqual(drawn(110), [`${NSW_CONTOUR_SOURCE}-10m`, `${NSW_CONTOUR_SOURCE}-10m-label`]);
  assert.deepEqual(drawn(112), [`${NSW_CONTOUR_SOURCE}-2m`]);
  for (const invalid of [undefined, null, '100', 111]) assert.deepEqual(drawn(invalid), [], 'only numeric 2 m contour elevations are drawn');
});

test('independent contours retain full detail and labels when the NSW basemap is sparse or absent', async t => {
  const { providers, cache, profile } = await contourSetup(t);
  const prepared = await cache.get(providers.nsw, profile), contourLayers = prepared.style.layers.filter(layer => layer.source === NSW_CONTOUR_SOURCE);
  const twelve = prepared.atZoom(12);
  assert.equal(twelve.style.sources.esri.maxzoom, 12);
  assert.deepEqual(twelve.style.sources[NSW_CONTOUR_SOURCE], prepared.style.sources[NSW_CONTOUR_SOURCE]);
  assert.deepEqual(twelve.style.layers.filter(layer => layer.source === NSW_CONTOUR_SOURCE), contourLayers);
  const absent = prepared.atZoom(null);
  assert.ok(!Object.hasOwn(absent.style.sources, 'esri'));
  assert.ok(!absent.style.layers.some(layer => layer.source === 'esri'));
  assert.deepEqual(absent.style.layers.filter(layer => layer.source === NSW_CONTOUR_SOURCE), contourLayers);
  assert.ok(absent.style.layers.some(layer => layer.type === 'background'));
  assert.deepEqual(absent.style.sources[NSW_CONTOUR_SOURCE], prepared.style.sources[NSW_CONTOUR_SOURCE]);
  assert.deepEqual(validateStyleMin(absent.style), []);
  assert.notEqual(absent.revision, twelve.revision);
  assert.equal(prepared.style.sources.esri.maxzoom, 22);
});

test('dataset publication changes NSW cache identities without changing QLD pixels or earlier snapshots', async t => {
  const { providers, cache, profile } = await contourSetup(t);
  const old = await cache.get(providers.nsw, profile), oldQLD = await cache.get(providers.qld, profile);
  assert.equal(await cache.get(providers.nsw, profile), old);
  assert.deepEqual(oldQLD.style, (await cache.get(providers.qld, 'readable')).style);
  const nextProfile = { ...profile, contourDataset: contourDataset('b') };
  const next = await cache.get(providers.nsw, nextProfile);
  assert.notEqual(next.revision, old.revision, 'a new dataset invalidates PNGs even with an unchanged caller token');
  assert.notEqual(next.atZoom(null).revision, old.atZoom(null).revision);
  assert.deepEqual(old.style.sources[NSW_CONTOUR_SOURCE].tiles, [profile.contourDataset.tiles]);
  assert.equal(await cache.get(providers.qld, nextProfile), oldQLD);
  assert.equal((await cache.get(providers.nsw, profile)).revision, old.revision, 'an in-flight old profile still selects the old immutable data');
});

test('contours cannot load before publication or from an unapproved URL or malformed dataset', async t => {
  const { providers, cache, profile } = await contourSetup(t);
  await assert.rejects(cache.get(providers.nsw, 'nsw-2m'), { status: 503 });
  for (const patch of [
    { revision: '../escape' }, { revision: [profile.contourDataset.revision] },
    { tiles: 'https://example.invalid/private' }, { tiles: profile.contourDataset.tiles + '?redirect=1' },
    { bounds: [150, -34, 149, -33] }, { bounds: [150, NaN, 151, -33] }, { bounds: [150, -90, 151, -33] },
    { minzoom: 17 }, { maxzoom: 23 }, { minzoom: 10.5 }, { attribution: '' },
  ]) {
    await assert.rejects(cache.get(providers.nsw, { ...profile, contourDataset: { ...profile.contourDataset, ...patch } }), { status: 503 });
  }
  assert.equal(cache.stats.loads, 0, 'no incomplete or unsafe style enters the prepared cache');
});

test('custom basemap aliases remain proxied and their generated contours are independent', async t => {
  const { config, providers, cache, profile } = await contourSetup(t);
  const base = await getStyle(config, providers.nsw);
  base.sources.map = { ...base.sources.esri, tiles: ['https://example.invalid/private/{z}/{x}/{y}.pbf'] };
  delete base.sources.esri;
  for (const layer of base.layers) if (layer.source === 'esri') layer.source = 'map';
  const custom = await cache.get(providers.nsw, { ...profile, styles: { nsw: base } });
  assert.deepEqual(custom.style.sources.map.tiles, ['/vector/nsw/{z}/{x}/{y}.pbf']);
  assert.deepEqual(custom.style.sources[NSW_CONTOUR_SOURCE].tiles, [profile.contourDataset.tiles]);
  assert.equal(custom.atZoom(12).style.sources.map.maxzoom, 12);
  assert.ok(!custom.atZoom(null).style.sources.map);
  assert.ok(custom.atZoom(null).style.sources[NSW_CONTOUR_SOURCE]);
  base.sources[NSW_CONTOUR_SOURCE] = { type: 'vector', tiles: ['https://example.invalid/private'] };
  await assert.rejects(getStyle(config, providers.nsw, base), /reserved/);
});
