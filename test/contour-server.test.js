const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { gzipSync } = require('node:zlib');
const { createApp } = require('../server');
const { createNswContours } = require('../lib/nsw-contours');
const { loadConfig } = require('../lib/config');
const { atomicWrite } = require('../lib/utils');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/YYbL4QAAAAASUVORK5CYII=', 'base64');
const TILE_DATA = Buffer.from('local contour tile fixture');
const GZIP_TILE = gzipSync(TILE_DATA);
const SOURCE = 'nsw-2m-contours';

async function publish(root, digit = 'a') {
  const revision = digit.repeat(64);
  const manifest = { format: 1, revision, file: `published/${revision}.mbtiles`, bounds: [150, -34, 151, -33],
    minzoom: 10, maxzoom: 16, sheets: 1, sourceBytes: 1234, attribution: 'NSW Spatial Services, CC BY 3.0 AU' };
  await fs.mkdir(path.join(root, 'published'), { recursive: true });
  const db = new DatabaseSync(path.join(root, manifest.file));
  try {
    db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);');
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run('format', 'pbf');
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run('json', JSON.stringify({ vector_layers: [{ id: 'contours', fields: { elevation: 'Number' } }] }));
    db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)').run(10, 5, 1024 - 7 - 1, GZIP_TILE);
    db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)').run(10, 6, 1024 - 7 - 1, TILE_DATA);
  } finally { db.close(); }
  await fs.writeFile(path.join(root, 'published', `${revision}.json`), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(manifest));
  return manifest;
}

async function server(t, { ready = false, enabled = true, defaultProfile = 'nsw-2m', status } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-contour-http-'));
  let instance, listener, contours;
  t.after(async () => {
    if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
    if (instance) await instance.close(); else await contours?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const config = loadConfig({ DATA_DIR: dir, PORT: '0', CLEANUP_INTERVAL_MINUTES: '0', CACHE_MAX_GIB: '0', CACHE_MIN_FREE_GIB: '0',
    PREFETCH_RADIUS: '0', PREFETCH_ZOOM: '0', DEFAULT_PROFILE: defaultProfile, NSW_CONTOURS_ENABLED: enabled ? '1' : '0' });
  const root = config.nswContoursDir;
  if (ready) await publish(root);
  if (status) { await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'status.json'), JSON.stringify(status)); }
  let launches = 0;
  contours = createNswContours(config, {}, { spawn() { launches++; throw new Error('Tests must not launch an importer'); } });
  const jobs = [];
  instance = await createApp(config, { contours, nativeZoom: async () => 12,
    cache: { stats: {}, async get() { throw new Error('Tests must not request upstream resources'); } },
    renderer: { stats: {}, close() {}, async render(job) {
      jobs.push(job); for (const output of job.outputs || [job]) await atomicWrite(output.outPath, PNG);
    } },
  });
  listener = await new Promise((resolve, reject) => {
    const pending = instance.app.listen(0, '127.0.0.1', () => resolve(pending)); pending.once('error', reject);
  });
  const url = `http://127.0.0.1:${listener.address().port}`;
  instance.app.locals.internalOrigin = url;
  return { ...instance, config, root, url, contours, jobs, launches: () => launches };
}

function rawGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, data: Buffer.concat(chunks) }));
    });
    request.once('error', reject);
  });
}

test('preparation hides the new profile, falls back to Readable and leaves the ordinary map available', async t => {
  const s = await server(t);
  const catalog = await (await fetch(s.url + '/api/providers')).json();
  assert.equal(catalog.defaultProfile, 'readable');
  assert.ok(catalog.profiles.some(profile => profile.id === 'readable'));
  assert.ok(!catalog.profiles.some(profile => profile.id === 'nsw-2m'));
  assert.equal((await fetch(s.url + '/healthz')).status, 200);
  const style = await (await fetch(s.url + '/styles/nsw.json')).json();
  assert.deepEqual(style, await (await fetch(s.url + '/styles/readable/nsw.json')).json());
  assert.equal(style.sources[SOURCE], undefined);
  const fallback = await fetch(s.url + '/raster/nsw/15/30065/19647.png');
  assert.equal(fallback.status, 200); assert.equal(fallback.headers.get('x-qtopo-profile'), 'readable');
  for (const endpoint of ['/styles/nsw-2m/nsw.json', '/raster/nsw-2m/nsw/15/30065/19647.png', '/nsw-2m/15/30065/19647.png']) {
    const response = await fetch(s.url + endpoint);
    assert.equal(response.status, 503, endpoint);
    assert.equal(response.headers.get('retry-after'), '3');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Map service temporarily unavailable; please retry.' });
  }
  assert.equal(s.jobs.length, 1);
  assert.equal(s.launches(), 0, 'constructing and requesting the app must not start preparation');
});

test('published contours appear in browser and native styles without inheriting the basemap zoom limit', async t => {
  const s = await server(t, { ready: true });
  const catalog = await (await fetch(s.url + '/api/providers')).json();
  assert.equal(catalog.defaultProfile, 'nsw-2m');
  assert.ok(catalog.profiles.some(profile => profile.id === 'nsw-2m'));
  const browserStyle = await (await fetch(s.url + '/styles/nsw-2m/nsw.json')).json();
  const expected = `${s.url}/contours/nsw/${'a'.repeat(64)}/{z}/{x}/{y}.pbf`;
  assert.deepEqual(browserStyle.sources[SOURCE].tiles, [expected]);
  assert.deepEqual(browserStyle.sources[SOURCE].bounds, [150, -34, 151, -33]);
  assert.equal(browserStyle.sources[SOURCE].minzoom, 10);
  assert.equal(browserStyle.sources[SOURCE].maxzoom, 16);
  assert.ok(browserStyle.layers.some(layer => layer.source === SOURCE && layer['source-layer'] === 'contours'));
  assert.ok(!browserStyle.layers.some(layer => ['Contours', 'Contours/label'].includes(layer['source-layer'])));
  const response = await fetch(s.url + '/raster/nsw-2m/nsw/15/30065/19647.png');
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-qtopo-profile'), 'nsw-2m');
  const firstJob = s.jobs[0];
  assert.equal(firstJob.kind, 'vector');
  assert.deepEqual(firstJob.style.sources[SOURCE].tiles, [expected]);
  assert.equal(firstJob.style.sources[SOURCE].maxzoom, 16);
  assert.ok(Object.entries(firstJob.style.sources).filter(([id]) => id !== SOURCE).every(([, source]) => source.maxzoom === 12));
  await publish(s.root, 'b'); await s.contours.refresh(true);
  assert.equal((await fetch(s.url + '/raster/nsw-2m/nsw/15/30065/19647.png')).status, 200);
  assert.equal(s.jobs.length, 2, 'a new contour revision must not reuse an older rendered tile');
  assert.notEqual(s.jobs[1].outPath, firstJob.outPath);
  assert.match(s.jobs[1].style.sources[SOURCE].tiles[0], new RegExp('b'.repeat(64)));
  assert.equal((await fetch(s.url + `/contours/nsw/${'a'.repeat(64)}/10/5/7.pbf`)).status, 200, 'an in-flight older style remains usable');
  assert.equal(s.launches(), 0);
});

test('contour tile HTTP routes preserve gzip, cache immutable revisions and distinguish empty from invalid requests', async t => {
  const s = await server(t, { ready: true });
  const base = `${s.url}/contours/nsw/${'a'.repeat(64)}`;
  const compressed = await rawGet(base + '/10/5/7.pbf');
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.match(compressed.headers['content-type'], /application\/x-protobuf/);
  assert.equal(compressed.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(compressed.headers['access-control-allow-origin'], '*');
  assert.deepEqual(compressed.data, GZIP_TILE);
  assert.deepEqual(Buffer.from(await (await fetch(base + '/10/5/7.pbf')).arrayBuffer()), TILE_DATA);
  const uncompressed = await rawGet(base + '/10/6/7.pbf');
  assert.equal(uncompressed.headers['content-encoding'], undefined);
  assert.deepEqual(uncompressed.data, TILE_DATA);
  const missing = await rawGet(base + '/10/7/7.pbf');
  assert.equal(missing.status, 204); assert.equal(missing.data.length, 0);
  assert.equal((await fetch(base + '/9/5/7.pbf')).status, 204);
  for (const suffix of ['/10/1024/7.pbf', '/-1/5/7.pbf', '/10/5/NaN.pbf']) assert.equal((await fetch(base + suffix)).status, 400);
  assert.equal((await fetch(`${s.url}/contours/nsw/invalid/10/5/7.pbf`)).status, 400);
  assert.equal((await fetch(`${s.url}/contours/nsw/${'f'.repeat(64)}/10/5/7.pbf`)).status, 404);
});

test('public progress excludes internal errors and path-like sheet identifiers', async t => {
  const s = await server(t, { status: { phase: 'waiting-space', completedSheets: 2, totalSheets: 343,
    downloadedBytes: 10_000, totalBytes: 20_000, currentSheet: '/private/data/secret-sheet.zip',
    message: '/private/data: failed while using secret-token', traceback: 'private traceback' } });
  const response = await fetch(s.url + '/api/contours');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const status = await response.json();
  assert.equal(status.available, false); assert.equal(status.phase, 'waiting-space');
  assert.equal(status.completedSheets, 2); assert.equal(status.totalSheets, 343);
  assert.equal(status.downloadedBytes, 10_000); assert.equal(status.totalBytes, 20_000);
  assert.equal(status.currentSheet, null);
  assert.doesNotMatch(JSON.stringify(status), /secret|private|traceback|message/);
});

test('disabled startup does not launch preparation and retained data stays unavailable', async t => {
  const s = await server(t, { ready: true, enabled: false });
  await s.start(); await s.start();
  const status = await (await fetch(s.url + '/api/contours')).json();
  assert.equal(status.enabled, false); assert.equal(status.available, false); assert.equal(status.phase, 'disabled');
  const catalog = await (await fetch(s.url + '/api/providers')).json();
  assert.equal(catalog.defaultProfile, 'readable');
  assert.ok(!catalog.profiles.some(profile => profile.id === 'nsw-2m'));
  assert.equal((await fetch(s.url + `/contours/nsw/${'a'.repeat(64)}/10/5/7.pbf`)).status, 503);
  assert.equal(s.launches(), 0);
});
