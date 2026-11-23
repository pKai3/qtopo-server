const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { options, tilesFor, run } = require('../scripts/load-tiles');

test('load generator validates its bounds and spreads initial requests across render grids', () => {
  assert.throws(() => options(['--concurrency', '0']));
  assert.throws(() => options(['--z', '1']));
  assert.throws(() => options(['--width', '9999']));
  assert.throws(() => options(['--mystery', '1']));
  const tiles = tilesFor(options([]));
  assert.equal(tiles.length, 64);
  assert.equal(new Set(tiles.slice(0, 8).map(t => `${Math.floor(t.x / 2)}/${Math.floor(t.y / 2)}`)).size, 8);
});

test('load generator respects request concurrency, reports failures and makes each request once', async t => {
  let active = 0, peak = 0; const paths = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/readyz') { res.writeHead(404); res.end(); return; }
    paths.push(req.url); active++; peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      if (req.url.endsWith('/37951.png')) { res.writeHead(502); res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('89504e470d0a1a0a', 'hex')); }
    }, 30);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const result = await run(options(['--url', `http://127.0.0.1:${server.address().port}`, '--width', '3', '--height', '2', '--concurrency', '2']), () => {});
  assert.equal(paths.length, 6); assert.equal(new Set(paths).size, 6);
  assert.equal(peak, 2); assert.equal(result.peakRequests, 2);
  assert.equal(result.succeeded, 3); assert.equal(result.failed, 3);
  assert.equal(result.peakRenderJobsObserved, null);
  assert.equal(result.serverCacheHits, null);
});

test('stopping a load test lets accepted requests finish and skips the remainder', async t => {
  const stop = new AbortController();
  let accepted = 0, statusCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/readyz') {
      if (++statusCalls === 1) { res.writeHead(503); res.end(); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ renderer: { active: 0, queued: 0 } })); }
      return;
    }
    if (++accepted === 2) stop.abort();
    setTimeout(() => res.end(Buffer.from('89504e470d0a1a0a', 'hex')), 40);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const progress = [];
  const result = await run(options(['--url', `http://127.0.0.1:${server.address().port}`, '--width', '3', '--height', '2', '--concurrency', '2']), () => {}, { signal: stop.signal, onProgress: value => progress.push(value) });
  assert.equal(accepted, 2); assert.equal(result.started, 2); assert.equal(result.skipped, 4);
  assert.equal(result.succeeded, 2); assert.equal(result.failed, 0); assert.equal(result.stopped, true);
  assert.equal(progress.at(-1).active, 0);
  assert.equal(result.peakRenderJobsObserved, 0, 'later status samples still count when the initial status request failed');
  assert.equal(result.serverCacheHits, null, 'a missing baseline must not become a fabricated cache delta');
});
