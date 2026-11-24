const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server');
const { listenControl, requestControl } = require('../lib/local-control');
const { loadConfig } = require('../lib/config');
const { atomicWrite } = require('../lib/utils');
const { createProviders, tileURL, parseTile } = require('../lib/providers');
const { getStyle, renderStyle, absoluteStyle, styleRevision } = require('../lib/styles');
const { validateStyleMin } = require('@maplibre/maplibre-gl-style-spec');
const logger = require('../lib/logger');
const { setTimeout: sleep } = require('node:timers/promises');
const { createRenderFlyby } = require('../lib/render-flyby');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/YYbL4QAAAAASUVORK5CYII=', 'base64');
async function server(t, dependencies = {}, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-app-test-'));
  const config = loadConfig({ DATA_DIR: dir, PORT: '0', CLEANUP_INTERVAL_MINUTES: '0', PREFETCH_RADIUS: '0', ADMIN_ALLOWED_NETWORKS: '127.0.0.1/32', ...env });
  const instance = await createApp(config, dependencies);
  const listener = await new Promise(resolve => { const s = instance.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = 'http://127.0.0.1:' + listener.address().port;
  instance.app.locals.internalOrigin = url;
  const controlDir = await fs.mkdtemp('/tmp/qtopo-control-test-');
  const socket = path.join(controlDir, 'control.sock');
  const control = await listenControl(instance.actions, socket);
  t.after(async () => { instance.close(); control.closeAllConnections(); await new Promise(r => control.close(r)); await fs.rm(controlDir, { recursive: true, force: true }); listener.closeAllConnections(); await new Promise(r => listener.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  return { ...instance, config, url, socket };
}
const actionHeaders = { 'Content-Type': 'application/json', 'X-QTopo-Action': 'status-page' };
const webAction = (s, route, body = {}, headers = actionHeaders) => fetch(s.url + '/api/actions/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
const action = async (s, route, body = {}) => {
  try {
    const data = await requestControl('/' + route, body, s.socket);
    return { status: route === 'tile-test/stop' ? 200 : 202, json: async () => data };
  } catch (error) { return { status: error.status, json: async () => ({ error: error.message }) }; }
};
// Fetch controls the Host header; use HTTP directly to exercise hostile hosts.
const statusWithHeaders = (url, headers) => new Promise((resolve, reject) => {
  http.get(url, { headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject);
});
async function waitForActions(s, predicate) {
  for (let i = 0; i < 150; i++) {
    const state = await requestControl('/status', undefined, s.socket);
    if (predicate(state)) return state;
    await sleep(20);
  }
  assert.fail('Status action did not reach the expected state');
}
test('browser vector tiles repair empty values while native rendering retains raw cached data', async t => {
  // A named, versioned empty layer with an invalid empty Value dictionary entry.
  const raw = Buffer.from([26, 7, 10, 1, 97, 120, 2, 34, 0]);
  let cachedPath;
  const s = await server(t, { cache: { stats: {}, async get({ file }) {
    cachedPath = file; await atomicWrite(file, raw); return { path: file };
  } } });
  const url = s.url + '/vector/qld/17/121026/76203.pbf';
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), raw);
  const response = await fetch(url + '?values=2');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([26, 9, 10, 1, 97, 120, 2, 34, 2, 32, 0]));
  assert.deepEqual(await fs.readFile(cachedPath), raw, 'the existing upstream cache is preserved');
  const browserStyle = await (await fetch(s.url + '/styles/qld.json')).json();
  assert.ok(Object.values(browserStyle.sources).every(src => src.tiles.every(url => url.endsWith('?values=2'))));
});
test('public status is read-only: web controls are absent even with spoofed proxy headers', async t => {
  let renders = 0;
  const s = await server(t, { renderer: { stats: { active: 0, lastRender: { z:16, x:60500, y:37950 } }, close() {}, async render(job) { renders++; await atomicWrite(job.outPath, PNG); } } }, { ADMIN_ALLOWED_NETWORKS: '' });
  const retained = path.join(s.config.rasterDir, 'v2/retained.png');
  await atomicWrite(retained, PNG);
  for (const route of ['/status', '/status.html', '/status.js', '/status.css', '/readyz', '/STATUS', '/status/']) {
    const response = await fetch(s.url + route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    await response.arrayBuffer();
  }
  const data = await (await fetch(s.url + '/readyz')).json();
  assert.equal(data.logsAvailable, false);
  assert.equal(data.flybyAvailable, true);
  assert.equal(data.actions, undefined);
  assert.equal(data.renderer.lastRender, undefined);
  assert.equal((await fetch(s.url + '/api/logs')).status, 403);
  assert.equal((await fetch(s.url + '/api/render-flyby')).status, 200);
  for (const [route, body] of [['tile-test/start', { width: 1, height: 1 }], ['tile-test/stop', {}], ['cache/clear', { confirm: 'clear-rendered-tiles' }]]) {
    assert.equal((await webAction(s, route, body)).status, 404, route);
    assert.equal((await webAction(s, route, body, { ...actionHeaders, 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' })).status, 404);
  }
  for (const route of ['/api/actions/cache/clear', '/API/ACTIONS/cache/clear', '/api/%61ctions/cache/clear']) {
    for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS']) assert.equal((await fetch(s.url + route, { method })).status, 404);
  }
  assert.deepEqual(await fs.readFile(retained), PNG);
  assert.equal(renders, 0, 'public status and retired controls must not schedule rendering');
  const page = await (await fetch(s.url + '/status')).text();
  assert.doesNotMatch(page, /test-form|cache-clear|Start test|Clear rendered tiles/);
  const script = await (await fetch(s.url + '/status.js')).text();
  assert.doesNotMatch(script, /api\/actions|performAction/);
  for (const route of ['/raster/16/60500/37950.png', '/16/60500/37950.png']) {
    const response = await fetch(s.url + route, { headers: { Origin: 'https://www.gaiagps.com' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  }
});
test('private logs still require explicit networks and hostnames; local HTTP cannot run actions', async t => {
  const s = await server(t);
  assert.equal((await (await fetch(s.url + '/readyz')).json()).logsAvailable, true);
  assert.equal((await fetch(s.url + '/api/logs')).status, 200);
  for (const headers of [
    { Host: 'attacker.example' }, { Host: '127.0.0.1.attacker.example' },
    { 'X-Forwarded-For': '127.0.0.1' }, { 'X-Forwarded-Host': 'localhost' }, { 'X-Real-IP': '127.0.0.1' },
  ]) assert.equal(await statusWithHeaders(s.url + '/api/logs', headers), 403, JSON.stringify(headers));
  assert.equal((await webAction(s, 'tile-test/stop', {}, { ...actionHeaders, Origin: s.url })).status, 404);
});
test('public previews omit client details, validate cursors and never initiate rendering', async t => {
  let renders = 0;
  const flyby = createRenderFlyby();
  const s = await server(t, { flyby, renderer: { stats: {}, close() {}, render() { renders++; } } }, { ADMIN_ALLOWED_NETWORKS: '' });
  const first = await fetch(s.url + '/api/render-flyby');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('access-control-allow-origin'), null);
  const cursor = await first.json();
  flyby.publish('/9j/AA==', { z: 16, x: 60500, y: 37950, profile: 'readable', clientIp: '198.51.100.2', requestId: 'private-request', outPath: '/data/private.png' });
  const result = await (await fetch(s.url + '/api/render-flyby?after=0&session=' + cursor.session)).json();
  assert.equal(result.entries.length, 1);
  assert.deepEqual(Object.keys(result.entries[0]).sort(), ['id', 'image', 'priority', 'profile', 'time', 'zoom']);
  for (const query of ['after=-1', 'after=Infinity', 'after=1&after=2', 'session=' + 'a'.repeat(65)]) assert.equal((await fetch(s.url + '/api/render-flyby?' + query)).status, 400);
  for (const headers of [{ Host: 'public.example' }, { 'X-Forwarded-For': '198.51.100.2' }]) assert.equal(await statusWithHeaders(s.url + '/api/render-flyby', headers), 200);
  const status = await (await fetch(s.url + '/readyz')).json();
  assert.equal(status.flybyAvailable, true); assert.equal(status.entries, undefined); assert.equal(renders, 0);
  assert.equal(status.logsAvailable, false);
  assert.equal((await fetch(s.url + '/api/logs')).status, 403);
});
test('a trusted proxy must supply an allowed actual client to read logs, but cannot enable web actions', async t => {
  const s = await server(t, {}, { TRUSTED_PROXIES: '127.0.0.1/32', ADMIN_ALLOWED_NETWORKS: '192.0.2.0/24,2001:db8:1::/64' });
  for (const client of ['192.0.2.42', '2001:db8:1::2']) {
    assert.equal((await fetch(s.url + '/api/logs', { headers: { 'X-Forwarded-For': client } })).status, 200);
  }
  for (const headers of [{}, { 'X-Forwarded-For': '198.51.100.2' }, { 'X-Forwarded-For': '192.0.2.42, 198.51.100.2' }, { 'X-Forwarded-For': 'not-an-address' }]) {
    assert.equal((await fetch(s.url + '/api/logs', { headers })).status, 403);
  }
  assert.equal((await webAction(s, 'cache/clear', { confirm: 'clear-rendered-tiles' }, { ...actionHeaders, 'X-Forwarded-For': '192.0.2.42' })).status, 404);
});
test('local socket controls run one tile test, reject unsafe inputs and stop without aborting accepted tiles', async t => {
  let release, renders = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const s = await server(t, { renderer: { close() {}, async render(job) { renders++; await blocked; await atomicWrite(job.outPath, PNG); } } });
  assert.equal((await action(s, 'tile-test/start', { url: 'http://other-server/' })).status, 400);
  assert.equal((await action(s, 'tile-test/start', { width: 1000 })).status, 400);
  assert.equal((await action(s, 'tile-test/start', { z: 22 })).status, 400);
  assert.equal((await action(s, 'tile-test/start', { width: 3, height: 2, concurrency: 2 })).status, 202);
  assert.equal((await action(s, 'tile-test/start')).status, 409);
  assert.equal((await action(s, 'cache/clear', { confirm: 'clear-rendered-tiles' })).status, 409);
  for (let i = 0; i < 100 && renders < 2; i++) await sleep(10);
  assert.equal(renders, 2);
  assert.equal((await action(s, 'tile-test/stop')).status, 200);
  release();
  const state = await waitForActions(s, value => value.test.phase === 'stopped');
  assert.equal(state.test.result.succeeded, 2); assert.equal(state.test.result.failed, 0);
  assert.equal(state.test.result.skipped, 4); assert.equal(renders, 2);
  assert.equal((await action(s, 'tile-test/start', { width: 1, height: 1 })).status, 202);
  const completed = await waitForActions(s, value => value.test.phase === 'complete');
  assert.equal(completed.test.result.succeeded, 1);
  assert.equal(completed.test.result.serverCacheHits, 1);
});
test('cache clearing waits for metatile siblings, gates new requests and preserves downloads, user files and symlink targets', async t => {
  let active = 1, output;
  const s = await server(t, { renderer: { get stats() { return { active, queued: 0 }; }, close() {}, async render(job) { output = job.outPath; await atomicWrite(output, PNG); } } });
  await (await fetch(s.url + '/raster/16/60500/37950.png')).arrayBuffer();
  const retained = [path.join(s.config.vectorDir, 'v2/qld/test.pbf'), path.join(s.config.rasterDir, 'v2/readme.txt'), path.join(s.config.resourceDir, 'v2/sprite.png'), path.join(s.config.rasterDir, 'outside.png')];
  for (const file of retained) await atomicWrite(file, PNG);
  const root = path.join(s.config.rasterDir, 'v2');
  await atomicWrite(path.join(root, 'old.png'), PNG);
  await atomicWrite(path.join(root, 'old.png.empty'), 'empty');
  await fs.symlink(s.config.resourceDir, path.join(root, 'linked-resources'));
  assert.equal((await action(s, 'cache/clear')).status, 400);
  const started = await action(s, 'cache/clear', { confirm: 'clear-rendered-tiles' });
  assert.equal(started.status, 202);
  assert.equal((await started.json()).clearing.phase, 'waiting');
  await fs.access(output);
  assert.equal((await action(s, 'cache/clear', { confirm: 'clear-rendered-tiles' })).status, 409);
  assert.equal((await action(s, 'tile-test/start')).status, 409);
  const gated = await fetch(s.url + '/raster/16/60501/37950.png');
  assert.equal(gated.status, 503); assert.equal(gated.headers.get('retry-after'), '3');
  active = 0;
  const done = await waitForActions(s, value => value.clearing.phase === 'done');
  assert.equal(done.clearing.removed, 2);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'old.png.empty')), { code: 'ENOENT' });
  for (const file of retained) assert.deepEqual(await fs.readFile(file), PNG);
  assert.equal((await fs.lstat(path.join(root, 'linked-resources'))).isSymbolicLink(), true);
  assert.equal((await (await fetch(s.url + '/readyz')).json()).prefetch.paused, false);
  assert.equal((await fetch(s.url + '/raster/16/60500/37950.png')).status, 200);
});
test('status log endpoint returns only new application messages and rejects invalid cursors', async t => {
  const s = await server(t);
  const cursor = logger.read();
  logger.log('TEST', 'Log panel message <plain text>');
  const response = await fetch(`${s.url}/api/logs?after=${cursor.next}&session=${cursor.session}`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.entries.length, 1); assert.match(result.entries[0].line, /Log panel message <plain text>/);
  assert.equal((await (await fetch(`${s.url}/api/logs?after=${result.next}&session=${result.session}`)).json()).entries.length, 0);
  assert.equal((await fetch(s.url + '/api/logs?after=-1')).status, 400);
  assert.equal((await fetch(s.url + '/api/logs?after=1&after=2')).status, 400);
});
test('browser preview loads its MapLibre module from an existing JavaScript asset', async t => {
  const s = await server(t);
  const html = await (await fetch(s.url + '/')).text();
  const script = html.match(/<script\b[^>]*src="([^"]+)"[^>]*>/);
  assert.ok(script, 'viewer entry script is present');
  assert.match(script[0], /type="module"/);
  const viewer = await fetch(new URL(script[1], s.url));
  assert.equal(viewer.status, 200);
  const imported = (await viewer.text()).match(/import \* as maplibregl from ['"]([^'"]+)['"]/);
  assert.ok(imported, 'MapLibre is explicitly imported');
  const library = await fetch(new URL(imported[1], s.url));
  assert.equal(library.status, 200);
  assert.match(library.headers.get('content-type'), /javascript/);
});
test('public map endpoints support cross-origin clients without allowing cross-origin status or log reads', async t => {
  const s = await server(t, { renderer: { close() {}, async render(job) { await atomicWrite(job.outPath, PNG); } } });
  const headers = { Origin: 'https://www.gaiagps.com' };
  for (const route of ['/raster/qld/3/7/4.png', '/styles/qld.json', '/api/providers', '/fonts/Open%20Sans%20Regular,Arial%20Unicode%20MS%20Regular/0-255.pbf', '/fonts/Open%20Sans%20Regular,Arial%20Unicode%20MS%20Regular/8192-8447.pbf']) {
    const result = await fetch(s.url + route, { headers });
    assert.equal(result.status, 200); assert.equal(result.headers.get('access-control-allow-origin'), '*');
    assert.equal(result.headers.get('access-control-allow-credentials'), null);
    await result.arrayBuffer();
  }
  const preflight = await fetch(s.url + '/raster/3/7/4.png', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'If-None-Match' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
  assert.match(preflight.headers.get('access-control-allow-headers'), /If-None-Match/);
  const invalid = await fetch(s.url + '/raster/qld/3/99/0.png', { headers });
  assert.equal(invalid.status, 400); assert.equal(invalid.headers.get('access-control-allow-origin'), '*');
  for (const route of ['/readyz', '/api/logs']) {
    const result = await fetch(s.url + route, { headers });
    assert.equal(result.headers.get('access-control-allow-origin'), null); await result.arrayBuffer();
  }
  const ordinary = await fetch(s.url + '/raster/13/7578/4746.png', { headers });
  const short = await fetch(s.url + '/13/7578/4746.png', { headers });
  assert.equal(short.status, 200); assert.equal(short.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await short.arrayBuffer()), Buffer.from(await ordinary.arrayBuffer()));
});
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
  const response = await fetch(s.url + '/readyz'), status = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(status.requests.errors, 1); assert.equal(status.requests.completed, 2);
  assert.equal(status.requests.hits, 1); assert.equal(status.requests.misses, 1);
  assert.equal(status.requests.active, 0); assert.equal(status.styles.loads, 1);
  assert.equal((await fetch(s.url + '/status')).status, 200);
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
test('expired raster tiles are regenerated before delivery and never served stale on failure', async t => {
  let file, fail = false, renders = 0;
  const s = await server(t, { renderer: { close() {}, async render(job) {
    renders++; file = job.outPath;
    if (fail) throw new Error('upstream unavailable');
    await atomicWrite(file, PNG);
  } } });
  const url = s.url + '/raster/qld/3/7/4.png';
  assert.equal((await fetch(url)).status, 200);
  await fs.utimes(file, new Date(0), new Date(0)); fail = true;
  const failed = await fetch(url);
  assert.equal(failed.status, 502); assert.equal(failed.headers.get('cache-control'), 'no-store');
  fail = false;
  assert.equal((await fetch(url)).status, 200); assert.equal(renders, 3);
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
    nativeZoom: async (_provider, tile) => tile.z,
    cache: { stats: {}, async get(opts) { calls.push(opts); return { path: '/example/source.jpeg', empty: false }; } },
    renderer: { close() {}, async render(job) { jobs.push(job); await atomicWrite(job.outPath, PNG); } },
  });
  assert.equal((await fetch(s.url + '/raster/nsw-topo/10/938/610.png')).status, 200);
  assert.equal(calls[0].kind, 'image'); assert.match(calls[0].url, /tile\/10\/610\/938/);
  assert.equal(jobs[0].kind, 'image'); assert.equal(jobs[0].size, 256); assert.equal(jobs[0].inputPath, '/example/source.jpeg');
});
test('NSW grid outputs stay isolated when neighbouring tiles have different native zooms', async t => {
  const jobs = [];
  const s = await server(t, {
    nativeZoom: async (_provider, tile) => tile.x % 2 ? 12 : 16,
    renderer: { close() {}, async render(job) { jobs.push(job); await atomicWrite(job.outPath, PNG); } },
  });
  assert.equal((await fetch(s.url + '/raster/nsw/16/60000/39000.png')).status, 200);
  assert.equal((await fetch(s.url + '/raster/nsw/16/60001/39000.png')).status, 200);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0].layout, jobs[1].layout);
  assert.notEqual(jobs[0].renderKey, jobs[1].renderKey);
  assert.deepEqual(jobs[0].outputs.map(t => t.x), [60000, 60000]);
  assert.deepEqual(jobs[1].outputs.map(t => t.x), [60001, 60001]);
  assert.notEqual(jobs[0].styleKey, jobs[1].styleKey);
});
test('request focus uses trusted client IPs and cache hits update existing render interests', async t => {
  const seen = [];
  const s = await server(t, { renderer: { close() {}, async render(job, interest) {
    seen.push(interest); await atomicWrite(job.outPath, PNG);
  } } }, { TRUSTED_PROXIES: '127.0.0.1/32', REQUEST_PAN_THRESHOLD: '3' });
  const get = (tile, client) => fetch(s.url + '/raster/qld/' + tile + '.png', { headers: { 'X-Forwarded-For': client } });
  assert.equal((await get('13/7578/4746', '192.0.2.1')).status, 200);
  assert.equal((await get('14/15156/9492', '192.0.2.1')).status, 200);
  assert.equal((await get('13/7579/4746', '192.0.2.2')).status, 200);
  assert.deepEqual(seen.map(interest => interest.score()), [0, 2, 2]);
  assert.equal((await get('13/7578/4746', '192.0.2.1')).status, 200);
  assert.equal(seen.length, 3, 'the final request is a cache hit');
  assert.deepEqual(seen.map(interest => interest.score()), [2, 0, 2]);
  const status = await (await fetch(s.url + '/readyz')).json();
  assert.equal(status.settings.requestPanThreshold, 3);
  assert.doesNotMatch(JSON.stringify(status), /192\.0\.2\.[12]|7578|15156/);
});

test('untrusted forwarded addresses cannot split one client into separate focus buckets', async t => {
  const seen = [];
  const s = await server(t, { renderer: { close() {}, async render(job, interest) {
    seen.push(interest); await atomicWrite(job.outPath, PNG);
  } } });
  await fetch(s.url + '/raster/qld/13/7578/4746.png', { headers: { 'X-Forwarded-For': '192.0.2.1' } });
  await fetch(s.url + '/raster/qld/14/15156/9492.png', { headers: { 'X-Forwarded-For': '192.0.2.2' } });
  assert.deepEqual(seen.map(interest => interest.score()), [0, 2]);
});

test('cancellation during live profile discovery releases the request without starting render work', async t => {
  let started, release, renders = 0;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const s = await server(t, { renderer: { close() {}, async render(job) {
    renders++; await atomicWrite(job.outPath, PNG);
  } } });
  const readdir = fs.readdir;
  t.mock.method(fs, 'readdir', async (...args) => {
    if (args[0] === s.config.profileDir) { started(); await gate; }
    return readdir(...args);
  });
  // Let the catalog's 250 ms freshness window expire so this request rescans.
  await sleep(260);
  const request = http.get(s.url + '/raster/qld/13/7578/4746.png');
  request.on('error', () => {});
  const closed = new Promise(resolve => request.once('close', resolve));
  await began;
  request.destroy(); await closed;
  // Observe the close before allowing discovery to return.
  let status;
  for (let i = 0; i < 100; i++) {
    status = await (await fetch(s.url + '/readyz')).json();
    if (status.requests.disconnected === 1) break;
    await sleep(5);
  }
  assert.equal(status.requests.disconnected, 1);
  assert.equal(status.requests.active, 0);
  release();
  await fetch(s.url + '/api/providers'); // Wait for the shared scan to settle.
  status = await (await fetch(s.url + '/readyz')).json();
  assert.equal(status.requests.active, 0);
  assert.equal(status.prefetch.requests, 0);
  assert.equal(renders, 0);
});

test('client cancellation before or during delivery counts one disconnect without an HTTP error stack', async t => {
  for (const stage of ['rendering', 'delivery']) {
    let started, release;
    const began = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const s = await server(t, { renderer: { close() {}, async render(job) {
      started();
      if (stage === 'rendering') await gate;
      await atomicWrite(job.outPath, stage === 'delivery' ? Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024)]) : PNG);
    } } });
    const cursor = logger.read();
    const request = http.get(s.url + '/raster/qld/13/7578/4746.png', response => {
      response.once('data', () => response.destroy());
    });
    request.on('error', () => {});
    const closed = new Promise(resolve => request.once('close', resolve));
    await began;
    if (stage === 'rendering') request.destroy();
    await closed; release();
    let status;
    for (let i = 0; i < 100; i++) {
      status = await (await fetch(s.url + '/readyz')).json();
      if (status.requests.disconnected === 1 && status.prefetch.requests === 0) break;
      await sleep(5);
    }
    // Give sendFile's deferred close callback a chance to settle as well.
    await sleep(20);
    assert.equal(status.requests.disconnected, 1);
    assert.equal(status.requests.errors, 0);
    assert.equal(status.requests.active, 0);
    const logs = logger.read(cursor.next, cursor.session).entries.map(entry => entry.line).join('\n');
    assert.match(logs, /Disconnected:/);
    assert.doesNotMatch(logs, /\[HTTP\]/);
    assert.equal((await fetch(s.url + '/healthz')).status, 200);
  }
});

test('a transport-style error from a renderer is still reported while the client is connected', async t => {
  const s = await server(t, { renderer: { close() {}, async render() {
    throw Object.assign(new Error('fixture renderer write failed'), { code: 'EPIPE' });
  } } });
  const cursor = logger.read();
  assert.equal((await fetch(s.url + '/raster/qld/13/7578/4746.png')).status, 502);
  const logs = logger.read(cursor.next, cursor.session).entries.map(entry => entry.line).join('\n');
  assert.match(logs, /\[HTTP\].*fixture renderer write failed/);
});

test('configuration and ArcGIS tile order are explicit', () => {
  assert.equal(loadConfig({}).tilePx, 1024);
  assert.equal(loadConfig({ TILE_PX: '512' }).tilePx, 512);
  assert.equal(loadConfig({ PNG_COMPRESSION_LEVEL: '6' }).pngCompression, 6);
  assert.throws(() => loadConfig({ PNG_COMPRESSION_LEVEL: '10' }), /PNG_COMPRESSION_LEVEL/);
  assert.throws(() => loadConfig({ UPSTREAM_CONCURRENCY: '0' }), /UPSTREAM_CONCURRENCY/);
  assert.equal(loadConfig({ PREFETCH_RADIUS: '0' }).prefetchRadius, 0);
  assert.equal(loadConfig({ PREFETCH_RADIUS: '3' }).prefetchRadius, 3);
  assert.equal(loadConfig({ PREFETCH_RADIUS: '10' }).prefetchRadius, 10);
  assert.equal(loadConfig({}).requestPanThreshold, 8);
  assert.equal(loadConfig({ REQUEST_PAN_THRESHOLD: '3' }).requestPanThreshold, 3);
  assert.throws(() => loadConfig({ REQUEST_PAN_THRESHOLD: '0' }), /REQUEST_PAN_THRESHOLD/);
  assert.throws(() => loadConfig({ REQUEST_PAN_THRESHOLD: '1.5' }), /REQUEST_PAN_THRESHOLD/);
  for (const radius of ['-1', '1.5', '11', 'Infinity', 'invalid']) {
    assert.throws(() => loadConfig({ PREFETCH_RADIUS: radius }), /PREFETCH_RADIUS must be an integer between 0 and 10/);
  }
  assert.equal(loadConfig({ RENDER_CONCURRENCY: '8' }).prefetchConcurrency, 7);
  assert.equal(loadConfig({ RENDER_CONCURRENCY: '8', PREFETCH_CONCURRENCY: '3' }).prefetchConcurrency, 3);
  assert.equal(loadConfig({ RENDER_CONCURRENCY: '2', PREFETCH_CONCURRENCY: '8' }).prefetchConcurrency, 1);
  assert.equal(loadConfig({ PREFETCH_ZOOM: '0' }).prefetchZoom, false);
  assert.throws(() => loadConfig({ TILE_PX: '300' }), /TILE_PX/);
  assert.throws(() => loadConfig({ RENDER_CONCURRENCY: '-1' }), /RENDER_CONCURRENCY/);
  const config = loadConfig({ DATA_DIR: '/tmp/example', TILE_PX: '256', LABEL_SCALE: '1.4' });
  const p = createProviders(config); assert.match(tileURL(p.nsw, 13, 7551, 4724), /13\/4724\/7551\.pbf$/);
  assert.equal(parseTile({ z: '3', x: '8', y: '0' }), null);
  assert.notEqual(styleRevision({}, config, p.qld), styleRevision({}, { ...config, tilePx: 512 }, p.qld));
});

test('startup tuning is validated and reported as the effective running configuration', async t => {
  const values = { RENDER_MEMORY_GUARD: '0', RENDER_MEMORY_HEADROOM_MB: '256', RENDER_MEMORY_HEADROOM_PERCENT: '10',
    RENDER_MEMORY_INITIAL_WORKER_MB: '300', RENDER_WORKER_MAX_RSS_MB: '512', REQUEST_REPRIORITIZE: '0', REQUEST_PAN_THRESHOLD: '4', PREFETCH_PREEMPT: '0' };
  const s = await server(t, {}, values);
  const { settings } = await (await fetch(s.url + '/readyz')).json();
  assert.equal(settings.renderMemoryGuard, false);
  assert.equal(settings.renderMemoryHeadroomMb, 256);
  assert.equal(settings.renderMemoryHeadroomPercent, 10);
  assert.equal(settings.renderMemoryInitialWorkerMb, 300);
  assert.equal(settings.renderWorkerMaxRssMb, 512);
  assert.equal(settings.requestReprioritize, false);
  assert.equal(settings.requestPanThreshold, 4);
  assert.equal(settings.prefetchPreempt, false);
  for (const name of ['RENDER_MEMORY_GUARD', 'REQUEST_REPRIORITIZE', 'PREFETCH_PREEMPT']) {
    assert.throws(() => loadConfig({ [name]: '2' }), new RegExp(name));
  }
  for (const [name, value] of [['RENDER_MEMORY_HEADROOM_MB', '-1'], ['RENDER_MEMORY_HEADROOM_PERCENT', '51'], ['RENDER_MEMORY_INITIAL_WORKER_MB', '127']]) {
    assert.throws(() => loadConfig({ [name]: value }), new RegExp(name));
  }
});
test('the existing Gaia URL selects QLD and NSW vector rendering and combines border tiles', async t => {
  const calls = [], jobs = [];
  const s = await server(t, {
    nativeZoom: async (_provider, tile) => Math.min(tile.z, 16),
    cache: { stats: {}, async get(opts) { calls.push(opts); return { path: '/example/source.jpeg', empty: false }; } },
    renderer: { close() {}, async render(job) { jobs.push(job); await atomicWrite(job.outPath, PNG); } },
  });
  assert.equal((await fetch(s.url + '/raster/13/7578/4746.png')).status, 200);
  assert.equal(jobs.at(-1).kind, 'vector'); assert.equal(calls.length, 0);
  assert.equal((await fetch(s.url + '/raster/qld/13/7578/4746.png')).status, 200);
  assert.equal(jobs.length, 1, 'QLD keeps using its existing rendered cache');
  assert.equal((await fetch(s.url + '/raster/13/7516/4911.png')).status, 200);
  assert.equal(jobs.at(-1).kind, 'vector'); assert.equal(jobs.at(-1).size, 1024);
  assert.match(jobs.at(-1).style.glyphs, /resources\/nsw\/fonts/);
  assert.ok(Object.values(jobs.at(-1).style.sources).every(src => src.tiles[0].includes('/vector/nsw/')));
  assert.equal(calls.length, 0, 'automatic maps must never download pre-rendered map sheets');
  assert.equal((await fetch(s.url + '/raster/18/240524/157180.png')).status, 200);
  assert.equal(jobs.at(-1).z, 18, 'keep requested camera zoom');
  assert.ok(Object.values(jobs.at(-1).style.sources).every(src => src.maxzoom === 16), 'use the indexed vector parent');
  const count = jobs.length;
  await fetch(s.url + '/raster/13/7516/4911.png'); assert.equal(jobs.length, count, 'automatic tiles are cached');
  assert.equal((await fetch(s.url + '/raster/14/15179/9528.png')).status, 200);
  assert.equal(jobs.at(-1).kind, 'composite'); assert.ok(jobs.at(-1).backgroundPath); assert.ok(jobs.at(-1).clip.length);
  assert.equal(jobs.at(-1).images.length, 1);
  assert.equal(calls.length, 0);
  const catalog = await (await fetch(s.url + '/api/providers')).json();
  assert.equal(catalog.automatic.raster, s.url + '/raster/{z}/{x}/{y}.png');
});

test('named profile URLs isolate renders and aliases follow the configured default', async t => {
  const jobs = [];
  const s = await server(t, { nativeZoom: async () => 12, renderer: { stats: {}, close() {}, async render(job) {
    jobs.push(job); for (const output of job.outputs || [job]) await atomicWrite(output.outPath, PNG);
  } } }, { DEFAULT_PROFILE: 'readable' });
  const catalog = await (await fetch(s.url + '/api/providers')).json();
  assert.equal(catalog.defaultProfile, 'readable');
  assert.deepEqual(catalog.profiles.map(p => p.id), ['classic', 'readable', 'size-2x', 'size-3x', 'mobile-2x', 'mobile-3x']);
  const tile = '/13/7578/4746.png';
  for (const profile of catalog.profiles) {
    const response = await fetch(s.url + '/' + profile.id + tile);
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), '*');
    await response.arrayBuffer();
    assert.equal((await fetch(s.url + '/' + profile.id + tile, { method: 'OPTIONS' })).status, 204);
  }
  assert.equal(jobs.length, 6); assert.equal(new Set(jobs.map(j => j.outPath)).size, 6);
  const oldRevision = styleRevision(await getStyle(s.config, s.providers.qld), s.config, s.providers.qld);
  assert.ok(jobs[0].outPath.includes('/qld/' + oldRevision + '/'), 'Classic retains its existing cache path');
  for (const prefix of ['', '/raster', '/raster/qld', '/raster/readable/qld', '/readable']) {
    assert.equal((await fetch(s.url + prefix + tile)).status, 200);
  }
  assert.equal(jobs.length, 6, 'default aliases must reuse Readable, not render another copy');
  const original = await (await fetch(s.url + '/styles/classic/qld.json')).json();
  const mobile = await (await fetch(s.url + '/styles/mobile-3x/qld.json')).json();
  assert.deepEqual(await (await fetch(s.url + '/style.json')).json(), await (await fetch(s.url + '/styles/readable/qld.json')).json());
  assert.notDeepEqual(original.layers, mobile.layers);
  for (const prefix of ['/unknown', '/constructor', '/classic-v1']) assert.equal((await fetch(s.url + prefix + tile)).status, 404);
  assert.equal((await fetch(s.url + '/mobile-2x/25/1/1.png')).status, 400);
  assert.equal((await fetch(s.url + '/styles/unknown/qld.json')).status, 404);
  // NSW and the border must carry the profile through source-zoom selection
  // and both halves of a composite, rather than accidentally using the default.
  for (const profile of ['classic', 'mobile-3x']) {
    for (const tile of ['/12/3758/2455.png', '/14/15179/9529.png']) {
      assert.equal((await fetch(s.url + '/' + profile + tile)).status, 200);
    }
  }
  const nswJobs = jobs.filter(j => j.kind === 'vector' && j.outPath.includes('/nsw/'));
  assert.ok(nswJobs.length >= 2);
  assert.ok(nswJobs.every(j => Object.values(j.style.sources).every(source => source.maxzoom === 12)), 'profile retains NSW indexed parent zoom');
  assert.deepEqual(new Set(nswJobs.map(j => j.style.layers.find(l => l.layout?.['icon-image']).layout['icon-size'] ?? 1)), new Set([1, 3]));
  assert.ok(jobs.some(j => j.kind === 'composite'), 'exercise automatic border composition');
});

test('prefetch keeps the requested profile for neighbouring tiles', async t => {
  const jobs = [];
  const s = await server(t, { renderer: { stats: {}, close() {}, async render(job) {
    jobs.push(job); for (const output of job.outputs || [job]) await atomicWrite(output.outPath, PNG);
  } } }, { PREFETCH_RADIUS: '1', PREFETCH_ZOOM: '0', PREFETCH_QUEUE_LIMIT: '8' });
  for (const profile of ['classic', 'mobile-2x']) {
    assert.equal((await fetch(s.url + '/' + profile + '/13/7578/4746.png')).status, 200);
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(s.url + '/readyz')).json();
      if (!state.prefetch.queued && !state.prefetch.active) break;
      await sleep(20);
    }
  }
  const background = jobs.filter(j => j.priority === 1);
  assert.ok(background.length > 0);
  const sizes = new Set(background.map(j => j.style.layers.find(l => l.id === 'homesteads').layout['text-size']));
  assert.deepEqual(sizes, new Set([10, 20]));
});

test('profile files create and update public URLs without restart while Classic stays untouched', async t => {
  const jobs = [];
  const s = await server(t, { renderer: { stats: {}, close() {}, async render(job) {
    jobs.push(job); for (const output of job.outputs || [job]) await atomicWrite(output.outPath, PNG);
  } } });
  const { syncProfile } = require('../lib/profile-files');
  const tile = '/13/7578/4746.png', upload = path.join(s.config.dataDir, 'upload.json');
  assert.equal((await fetch(s.url + '/live-test' + tile)).status, 404);
  await fetch(s.url + '/classic' + tile);
  const classicPath = jobs.at(-1).outPath;
  const document = { format: 1, id: 'live-test', name: 'Live test', styles: {
    qld: await getStyle(s.config, s.providers.qld), nsw: await getStyle(s.config, s.providers.nsw),
  } };
  await fs.writeFile(upload, JSON.stringify(document)); await syncProfile(s.config, upload); await sleep(270);
  const response = await fetch(s.url + '/live-test' + tile);
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-qtopo-profile'), 'live-test');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0');
  const firstPath = jobs.at(-1).outPath;
  document.styles.qld.layers.find(l => l.id === 'roads-high').paint['line-color'] = '#123456';
  await fs.writeFile(upload, JSON.stringify(document)); await syncProfile(s.config, upload); await sleep(270);
  assert.equal((await fetch(s.url + '/live-test' + tile)).status, 200);
  assert.notEqual(jobs.at(-1).outPath, firstPath);
  assert.equal(jobs.at(-1).style.layers.find(l => l.id === 'roads-high').paint['line-color'], '#123456');
  const count = jobs.length;
  await fs.writeFile(path.join(s.config.profileDir, 'live-test.json'), '{invalid'); await sleep(270);
  assert.equal((await fetch(s.url + '/live-test' + tile)).status, 200);
  await fetch(s.url + '/classic' + tile); await fetch(s.url + tile);
  assert.equal(jobs.length, count, 'invalid upload keeps prior pixels; Classic aliases still hit their old cache');
  assert.ok(await fs.stat(classicPath)); assert.ok(await fs.stat(firstPath), 'old profile tiles are retained');
  const catalog = await (await fetch(s.url + '/api/providers')).json();
  assert.ok(catalog.profiles.some(p => p.id === 'live-test' && p.raster === s.url + '/live-test/{z}/{x}/{y}.png'));
  assert.equal((await fetch(s.url + '/api/profiles/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(document) })).status, 404);
});

test('anonymous client queue summaries are opt-in and read-only', async t => {
  let reads=0;
  const renderer={stats:{},close(){},get clientQueues(){reads++;return [{id:'client-1',rendering:{requested:1,neighbours:0,zoom:0},waiting:{requested:0,neighbours:0,zoom:0}}];}};
  const s=await server(t,{renderer});
  const plain=await (await fetch(s.url+'/readyz')).json();
  assert.equal(plain.clientQueues,undefined);assert.equal(reads,0);
  const split=await (await fetch(s.url+'/readyz?clients=1')).json();
  assert.equal(reads,1);assert.deepEqual(split.clientQueues,[{id:'client-1',rendering:{requested:1,neighbours:0,zoom:0},waiting:{requested:0,neighbours:0,zoom:0}}]);
});
