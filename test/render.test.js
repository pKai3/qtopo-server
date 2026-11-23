const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRenderer } = require('../lib/render');
const { createPrefetch } = require('../lib/prefetch');
const { metatileLayout } = require('../lib/metatile');
const { PRIORITY } = require('../lib/queue');
const { atomicWrite, cachedRaster } = require('../lib/utils');
const { prune } = require('../lib/cleaner');
const logger = require('../lib/logger');
const { createRequestFocus } = require('../lib/request-focus');

test('queued metatiles follow live focus and retain priority for another client sharing a sibling', async t => {
  for (const sharedClient of [false, true]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-focus-render-'));
    const renderer = createRenderer({ renderConcurrency: 1, renderQueueLimit: 8, rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 10000 }, path.join(__dirname, 'fixtures/render-worker.js'));
    t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
    const focus = createRequestFocus(), order = [], gate = path.join(root, 'go');
    const blocker = renderer.render({ outPath: path.join(root, 'blocker.png'), gate });
    const tile = { z: 6, x: 10, y: 10 }, outputs = [0, 1, 2, 3].map(i => ({ outPath: path.join(root, `${i}.png`) }));
    const old = { ...tile, renderKey: 'shared-grid', outputs, outPath: outputs[0].outPath, priority: PRIORITY.NEIGHBOUR };
    const initial = renderer.render(old, focus.observe('a', tile).forTile(tile));
    assert.equal(renderer.render({ ...old, priority: PRIORITY.REQUEST }, focus.observe('a', tile).forTile(tile)), initial);
    const oldDone = initial.then(() => order.push('old area'));
    const latest = { z: 7, x: 20, y: 20, outPath: path.join(root, 'latest.png') };
    const newDone = renderer.render(latest, focus.observe('a', latest).forTile(latest)).then(() => order.push('latest zoom'));
    let sibling;
    if (sharedClient) {
      const otherTile = { z: 6, x: 11, y: 11 };
      sibling = renderer.render({ ...old, outPath: outputs[3].outPath, priority: PRIORITY.REQUEST }, focus.observe('b', otherTile).forTile(otherTile));
    }
    await fs.writeFile(gate, 'go');
    await Promise.all([blocker, oldDone, newDone, sibling]);
    for (let i = 0; i < 100 && renderer.stats.active; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(order, sharedClient ? ['old area', 'latest zoom'] : ['latest zoom', 'old area']);
    assert.equal(renderer.stats.completed, 3, 'the shared grid is rendered only once');
    assert.equal(renderer.stats.completedTiles, 6);
    assert.equal(renderer.stats.spawned, 1);
  }
});
test('grid requests share one worker, promote prefetch, and receive each tile before the grid completes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-grid-test-'));
  const renderer = createRenderer({ renderConcurrency: 2, prefetchConcurrency: 1, renderQueueLimit: 4, rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 10000 }, path.join(__dirname, 'fixtures/render-worker.js'));
  t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  const outputs = [0, 1, 2, 3].map(i => ({ outPath: path.join(root, `${i}.png`) }));
  const job = { renderKey: 'grid', outputs, outPath: outputs[0].outPath, priority: PRIORITY.NEIGHBOUR, encodeGate: path.join(root, 'encode'), timings: { encodeMs: 1 } };
  const first = renderer.render(job);
  await first;
  assert.equal(renderer.stats.active, 1, 'first PNG is ready while the worker is still encoding siblings');
  assert.equal(renderer.stats.completed, 0);
  const second = renderer.render({ ...job, outPath: outputs[1].outPath, priority: PRIORITY.REQUEST });
  assert.equal(renderer.render({ ...job, outPath: outputs[1].outPath }), second);
  assert.deepEqual(renderer.stats.activeByPriority, { requested: 1, neighbours: 0, zoom: 0 });
  assert.equal(renderer.stats.spawned, 1);
  await fs.writeFile(job.encodeGate, 'go'); await second;
  for (let i = 0; i < 200 && renderer.stats.active; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(renderer.stats.completed, 1); assert.equal(renderer.stats.completedTiles, 4);
  assert.equal(renderer.stats.lastRender.priority, 'requested');
  assert.ok(renderer.stats.lastRender.firstTileMs <= renderer.stats.lastRender.workerMs);
  for (const output of outputs) await fs.access(output.outPath);
  await renderer.render({ ...job, outPath: outputs[3].outPath });
  assert.equal(renderer.stats.completed, 1, 'a prepared sibling needs no additional render');
});
test('a partial grid failure rejects unfinished tiles and allows retry without losing the completed tile', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-grid-fail-'));
  const renderer = createRenderer({ renderConcurrency: 1, renderQueueLimit: 4, rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 2000 }, path.join(__dirname, 'fixtures/render-worker.js'));
  t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  const outputs = ['first', 'second'].map(name => ({ outPath: path.join(root, `${name}.png`) }));
  const job = { renderKey: 'grid', outputs, outPath: outputs[0].outPath, failAfterFirst: true };
  const first = renderer.render(job);
  const second = assert.rejects(renderer.render({ ...job, outPath: outputs[1].outPath }), /partial failure/);
  await first; await second;
  await fs.access(outputs[0].outPath);
  await new Promise(resolve => setImmediate(resolve));
  await renderer.render({ ...job, outPath: outputs[1].outPath, failAfterFirst: false });
  await fs.access(outputs[1].outPath);
  assert.equal(renderer.stats.spawned, 2);
});
test('terminate a hung child and allow queued work to continue', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-worker-test-'));
  const renderer = createRenderer({ renderConcurrency: 1, renderQueueLimit: 2, rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 500 }, path.join(__dirname, 'fixtures/render-worker.js'));
  t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  const first = renderer.render({ hang: true, outPath: path.join(root, 'hung.png') });
  const check = assert.rejects(first, { status: 504 });
  const second = renderer.render({ outPath: path.join(root, 'good.png') });
  await check; assert.equal(await second, path.join(root, 'good.png'));
  assert.equal(await fs.readFile(path.join(root, 'good.png'), 'utf8'), 'rendered-test-output');
  await assert.rejects(fs.stat(path.join(root, 'hung.png')), { code: 'ENOENT' });
});
test('empty raster tiles expire even when positive cache lifetime is unlimited', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-empty-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const blank = path.join(root, 'blank.png'), good = path.join(root, 'good.png');
  await atomicWrite(blank + '.empty', '1'); await atomicWrite(blank, 'blank');
  await atomicWrite(good, 'good');
  assert.equal((await cachedRaster(blank, 0, 1000)).empty, true);
  await fs.utimes(blank, new Date(0), new Date(0)); await fs.utimes(good, new Date(0), new Date(0));
  assert.equal(await cachedRaster(blank, 0, 1000), null);
  assert.equal((await cachedRaster(good, 0, 1000)).empty, false);
  assert.equal(await prune(root, 0, 1000), 1);
  await assert.rejects(fs.stat(blank), { code: 'ENOENT' });
  await assert.rejects(fs.stat(blank + '.empty'), { code: 'ENOENT' });
  assert.equal(await fs.readFile(good, 'utf8'), 'good');
  const pending = path.join(root, 'pending.png.empty');
  await atomicWrite(pending, '1');
  await prune(root, 0, 1000);
  assert.equal(await fs.readFile(pending, 'utf8'), '1', 'keep a marker while its PNG is being written');
  await fs.utimes(pending, new Date(0), new Date(0));
  await prune(root, 0, 1000);
  await assert.rejects(fs.stat(pending), { code: 'ENOENT' });
});

test('reuse workers across tiles, deduplicate requests, and replace failed workers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-pool-test-'));
  const renderer = createRenderer({ renderConcurrency: 1, renderQueueLimit: 4, rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 2000 }, path.join(__dirname, 'fixtures/render-worker.js'));
  t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  const tile = i => ({ outPath: path.join(root, `${i}.png`), recordPid: path.join(root, `${i}.pid`) });
  const first = renderer.render(tile(1));
  assert.equal(renderer.render(tile(1)), first);
  await first; await renderer.render(tile(2));
  assert.equal(await fs.readFile(tile(1).recordPid, 'utf8'), await fs.readFile(tile(2).recordPid, 'utf8'));
  await assert.rejects(renderer.render({ ...tile(3), fail: true }), /fixture failure/);
  await renderer.render(tile(3));
  assert.notEqual(await fs.readFile(tile(2).recordPid, 'utf8'), await fs.readFile(tile(3).recordPid, 'utf8'));
  assert.equal(renderer.stats.spawned, 2);
});

test('replace an oversized worker after successful output and wait for it to exit before reusing its slot', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-memory-test-'));
  const renderer = createRenderer({ renderConcurrency: 1, renderQueueLimit: 4, renderWorkerMaxRssMb: 256,
    rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 2000 }, path.join(__dirname, 'fixtures/render-worker.js'));
  t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  const tile = i => ({ outPath: path.join(root, `${i}.png`), recordPid: path.join(root, `${i}.pid`) });
  await renderer.render({ ...tile(1), rssBytes: 256 * 1024 ** 2 });
  await renderer.render({ ...tile(2), rssBytes: 100 * 1024 ** 2, assertExitedPidFile: tile(1).recordPid });
  await renderer.render({ ...tile(3), rssBytes: 100 * 1024 ** 2 });
  assert.notEqual(await fs.readFile(tile(1).recordPid, 'utf8'), await fs.readFile(tile(2).recordPid, 'utf8'));
  assert.equal(await fs.readFile(tile(2).recordPid, 'utf8'), await fs.readFile(tile(3).recordPid, 'utf8'), 'reuse workers below the memory threshold');
  assert.equal(renderer.stats.recycledForMemory, 1);
  assert.equal(renderer.stats.peakWorkerRssBytes, 256 * 1024 ** 2);
  assert.equal(renderer.stats.workerMaxRssBytes, 256 * 1024 ** 2);
  assert.equal(renderer.stats.spawned, 2);
  for (let i = 1; i <= 3; i++) assert.equal(await fs.readFile(tile(i).outPath, 'utf8'), 'rendered-test-output');
});

test('native worker crash output reaches the application log and subsequent work can recover', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-crash-test-'));
  const renderer = createRenderer({ renderConcurrency: 1, renderQueueLimit: 4, rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 2000 }, path.join(__dirname, 'fixtures/render-worker.js'));
  t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  const cursor = logger.read();
  await assert.rejects(renderer.render({ crash: true, outPath: path.join(root, 'crash.png') }), /Renderer exited 7/);
  await renderer.render({ outPath: path.join(root, 'recovered.png') });
  const output = logger.read(cursor.next, cursor.session).entries.map(entry => entry.line).join('\n');
  assert.match(output, /\[NATIVE\]:.*worker \d+: native fixture output/);
  assert.match(output, /\[NATIVE\]:.*worker \d+: native fixture fatal without newline/);
  assert.equal(renderer.stats.spawned, 2);
});

test('concurrency eight actually starts eight separate workers simultaneously', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-parallel-test-'));
  const renderer = createRenderer({ renderConcurrency: 8, renderQueueLimit: 16, rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 10000 }, path.join(__dirname, 'fixtures/render-worker.js'));
  t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  const gate = path.join(root, 'go');
  const jobs = Array.from({ length: 8 }, (_, i) => renderer.render({ outPath: path.join(root, `${i}.png`), recordPid: path.join(root, `${i}.pid`), gate }));
  const complete = Promise.all(jobs);
  try {
    for (let i = 0; i < 200; i++) {
      if ((await fs.readdir(root)).filter(name => name.endsWith('.pid')).length === 8) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const pids = await Promise.all(Array.from({ length: 8 }, (_, i) => fs.readFile(path.join(root, `${i}.pid`), 'utf8')));
    assert.equal(new Set(pids).size, 8);
    assert.equal(renderer.stats.active, 8);
    assert.equal(renderer.stats.peakActive, 8);
  } finally { await fs.writeFile(gate, 'go'); await complete; }
});

test('prefetch fills distinct metatile workers instead of spending its budget on sibling waiters', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-prefetch-grid-test-'));
  const renderer = createRenderer({ renderConcurrency: 8, prefetchConcurrency: 7, renderQueueLimit: 64,
    rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 10000 }, path.join(__dirname, 'fixtures/render-worker.js'));
  const file = tile => path.join(root, `${tile.z}-${tile.x}-${tile.y}.png`);
  const gate = path.join(root, 'go'), centre = { z: 6, x: 10, y: 10 };
  const group = tile => { const layout = metatileLayout(tile); return `${tile.z}/${layout.x}/${layout.y}`; };
  for (const tile of metatileLayout(centre).tiles) await fs.writeFile(file(tile), 'cached');
  const prefetch = createPrefetch({ radius: 2, zoom: false, concurrency: 7, delayMs: 1,
    groupKey: (_provider, tile) => group(tile),
    render: async (_provider, tile, priority, rank) => {
      if (await cachedRaster(file(tile), 10000, 1000)) return;
      const layout = metatileLayout(tile);
      await renderer.render({ ...tile, outPath: file(tile), priority, rank, renderKey: group(tile), gate,
        outputs: layout.tiles.map(sibling => ({ ...sibling, outPath: file(sibling) })),
      });
    },
  });
  t.after(async () => { prefetch.close(); renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  prefetch.begin('qld', centre)(true);
  for (let i = 0; i < 200 && renderer.stats.workers < 7; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(renderer.stats.workers, 7);
  assert.equal(renderer.stats.active, 7);
  assert.equal(prefetch.stats.activeGroups, 7);
  assert.ok(prefetch.stats.active > 7, 'siblings retain their individual promises without taking extra grid slots');
  assert.ok(prefetch.stats.queued > 0, 'additional grids remain bounded by the prefetch limit');
  const foreground = renderer.render({ outPath: path.join(root, 'foreground.png'), gate });
  for (let i = 0; i < 100 && renderer.stats.workers < 8; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(renderer.stats.active, 8, 'a requested render can still use the reserved eighth slot');
  assert.deepEqual(renderer.stats.activeByPriority, { requested: 1, neighbours: 7, zoom: 0 });
  await fs.writeFile(gate, 'go');
  await foreground;
  for (let i = 0; i < 200 && (prefetch.stats.active || prefetch.stats.queued); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(prefetch.stats.completed, 24);
  assert.equal(prefetch.stats.activeGroups, 0);
  assert.equal(renderer.stats.peakActive, 8, 'group admission must not change the real renderer concurrency cap');
});

test('a client joining an active prefetch shares the worker and reclassifies counters and timing logs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-promote-test-'));
  const renderer = createRenderer({ renderConcurrency: 2, renderQueueLimit: 4, rasterTTL: 10000, emptyTTL: 1000, renderTimeoutMs: 10000 }, path.join(__dirname, 'fixtures/render-worker.js'));
  t.after(async () => { renderer.close(); await fs.rm(root, { recursive: true, force: true }); });
  const job = { outPath: path.join(root, 'tile.png'), recordPid: path.join(root, 'tile.pid'), gate: path.join(root, 'go'), priority: PRIORITY.NEIGHBOUR, timings: { resourceWaitMs: 0, encodeMs: 1, cpuMs: 1 } };
  const background = renderer.render(job);
  try {
    for (let i = 0; i < 200; i++) {
      if (await fs.access(job.recordPid).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await fs.access(job.recordPid);
    assert.equal(renderer.stats.activeByPriority.neighbours, 1);
    const requested = renderer.render({ ...job, priority: PRIORITY.REQUEST });
    assert.equal(requested, background, 'the same render is shared');
    assert.deepEqual(renderer.stats.activeByPriority, { requested: 1, neighbours: 0, zoom: 0 });
    assert.equal(renderer.stats.spawned, 1);
  } finally { await fs.writeFile(job.gate, 'go'); await background; }
  assert.equal(renderer.stats.lastRender.priority, 'requested');
  assert.equal(renderer.stats.completed, 1);
});
