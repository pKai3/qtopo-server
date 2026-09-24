const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { loadConfig } = require('../lib/config');
const { atomicWrite } = require('../lib/utils');
const { createProviders, tileURL, parseTile } = require('../lib/providers');
const { getStyle, renderStyle, absoluteStyle, styleRevision } = require('../lib/styles');
const { validateStyleMin } = require('@maplibre/maplibre-gl-style-spec');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/YYbL4QAAAAASUVORK5CYII=', 'base64');
async function server(t, dependencies = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-app-test-'));
  const config = loadConfig({ DATA_DIR: dir, PORT: '0', CLEANUP_INTERVAL_MINUTES: '0' });
  const instance = await createApp(config, dependencies);
  const listener = await new Promise(resolve => { const s = instance.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = 'http://127.0.0.1:' + listener.address().port;
  instance.app.locals.internalOrigin = url;
  t.after(async () => { instance.close(); listener.closeAllConnections(); await new Promise(r => listener.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  return { ...instance, config, url };
}
test('reject malformed coordinates and unknown providers before work is scheduled', async t => {
  const s = await server(t, { renderer: { render() { assert.fail('must not render'); }, close() {} } });
  for (const p of ['/raster/qld/3/8/0.png', '/vector/qld/NaN/0/0.pbf', '/raster/nsw/-1/0/0.png', '/raster/qld/1.5/0/0.png', '/vector/nsw/23/0/0.pbf']) assert.equal((await fetch(s.url + p)).status, 400);
  assert.equal((await fetch(s.url + '/raster/nope/2/1/1.png')).status, 404);
});
test('render failure is retryable, uncached and cannot become a long-lived blank map', async t => {
  let attempts = 0;
  const s = await server(t, { renderer: { close() {}, async render(job) {
    attempts++; if (attempts === 1) throw new Error('temporary renderer failure');
    await atomicWrite(job.outPath, PNG);
  } } });
  const url = s.url + '/raster/13/7551/4724.png';
  const failed = await fetch(url); assert.equal(failed.status, 502); assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url)).status, 200); assert.equal((await fetch(url)).status, 200); assert.equal(attempts, 2);
});
test('editing a style invalidates raster cache without touching the existing user file', async t => {
  const paths = [];
  const s = await server(t, { renderer: { close() {}, async render(job) { paths.push(job.outPath); await atomicWrite(job.outPath, PNG); } } });
  const url = s.url + '/raster/qld/3/7/4.png';
  await fetch(url);
  const style = JSON.parse(await fs.readFile(s.config.stylePath)); style.layers[0].paint['fill-color'] = '#abcdef';
  await fs.writeFile(s.config.stylePath, JSON.stringify(style));
  await fetch(url); assert.equal(paths.length, 2); assert.notEqual(paths[0], paths[1]);
  assert.equal(JSON.parse(await fs.readFile(s.config.stylePath)).layers[0].paint['fill-color'], '#abcdef');
});
test('styles resolve provider tiles, fonts, sprites and attribution consistently', async t => {
  const s = await server(t);
  for (const p of Object.values(s.providers)) {
    const style = await getStyle(s.config, p);
    for (const scaled of [style, renderStyle(style, 1.4, p.id === 'qld')]) {
      assert.deepEqual(validateStyleMin(scaled).map(e => e.message), [], p.id);
    }
    const absolute = absoluteStyle(style, 'https://maps.example.test');
    assert.ok(Object.values(absolute.sources).every(src => src.tiles[0].startsWith('https://maps.example.test/')));
  }
  const response = await fetch(s.url + '/styles/nsw.json'); const style = await response.json();
  assert.ok(style.glyphs.includes('/resources/nsw/fonts/')); assert.ok(style.sprite.includes('/resources/nsw/sprites/'));
  assert.equal(style.layers[0].type, 'background');
  assert.deepEqual(renderStyle(style, 1, false).layers.filter(l => l.type === 'background'), style.layers.filter(l => l.type === 'background'));
  assert.equal((await fetch(s.url + '/tiles_raster/3/7/4.png', { redirect: 'manual' })).status, 308);
  assert.equal((await fetch(s.url + '/api/providers')).status, 200);
  assert.equal((await fetch(s.url + '/healthz')).status, 200);
  assert.equal((await fetch(s.url + '/assets/images/error.png')).status, 200);
});
test('NSW source imagery passes through the conversion queue and never the vector downloader', async t => {
  const calls = [], jobs = [];
  const s = await server(t, {
    cache: { stats: {}, async get(opts) { calls.push(opts); return { path: '/example/source.jpeg', empty: false }; } },
    renderer: { close() {}, async render(job) { jobs.push(job); await atomicWrite(job.outPath, PNG); } },
  });
  assert.equal((await fetch(s.url + '/raster/nsw-topo/10/938/610.png')).status, 200);
  assert.equal(calls[0].kind, 'image'); assert.match(calls[0].url, /tile\/10\/610\/938/);
  assert.equal(jobs[0].kind, 'image'); assert.equal(jobs[0].size, 256); assert.equal(jobs[0].inputPath, '/example/source.jpeg');
});
test('configuration and ArcGIS tile order are explicit', () => {
  assert.throws(() => loadConfig({ TILE_PX: '300' }), /TILE_PX/);
  assert.throws(() => loadConfig({ RENDER_CONCURRENCY: '-1' }), /RENDER_CONCURRENCY/);
  const config = loadConfig({ DATA_DIR: '/tmp/example', TILE_PX: '256', LABEL_SCALE: '1.4' });
  const p = createProviders(config); assert.match(tileURL(p.nsw, 13, 7551, 4724), /13\/4724\/7551\.pbf$/);
  assert.equal(parseTile({ z: '3', x: '8', y: '0' }), null);
  assert.notEqual(styleRevision({}, config, p.qld), styleRevision({}, { ...config, tilePx: 512 }, p.qld));
});
test('the existing Gaia URL selects QLD, NSW imagery and both sides of a border tile', async t => {
  const calls = [], jobs = [];
  const s = await server(t, {
    cache: { stats: {}, async get(opts) { calls.push(opts); return { path: '/example/source.jpeg', empty: false }; } },
    renderer: { close() {}, async render(job) { jobs.push(job); await atomicWrite(job.outPath, PNG); } },
  });
  assert.equal((await fetch(s.url + '/raster/13/7578/4746.png')).status, 200);
  assert.equal(jobs.at(-1).kind, 'vector'); assert.equal(calls.length, 0);
  assert.equal((await fetch(s.url + '/raster/qld/13/7578/4746.png')).status, 200);
  assert.equal(jobs.length, 1, 'QLD keeps using its existing rendered cache');
  assert.equal((await fetch(s.url + '/raster/13/7516/4911.png')).status, 200);
  assert.equal(jobs.at(-1).kind, 'composite'); assert.equal(jobs.at(-1).size, 512);
  assert.equal(jobs.at(-1).images.length, 4); assert.equal(jobs.at(-1).backgroundPath, null);
  assert.ok(calls.every(c => c.url.includes('/NSW_Topo_Map/MapServer/tile/14/')));
  const count = jobs.length;
  await fetch(s.url + '/raster/13/7516/4911.png'); assert.equal(jobs.length, count, 'automatic tiles are cached');
  assert.equal((await fetch(s.url + '/raster/14/15179/9528.png')).status, 200);
  assert.equal(jobs.at(-1).kind, 'composite'); assert.ok(jobs.at(-1).backgroundPath); assert.ok(jobs.at(-1).clip.length);
  const catalog = await (await fetch(s.url + '/api/providers')).json();
  assert.equal(catalog.automatic.raster, s.url + '/raster/{z}/{x}/{y}.png');
});
