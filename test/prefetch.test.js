const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPrefetch, neighbours, zoomNeighbours } = require('../lib/prefetch');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('adjacent prefetch stays within the XYZ grid and includes diagonals', () => {
  const tiles = neighbours({ z: 3, x: 4, y: 4 }, 1);
  assert.equal(tiles.length, 8);
  assert.ok(tiles.every(t => t.z === 3 && (t.x !== 4 || t.y !== 4)));
  assert.equal(neighbours({ z: 0, x: 0, y: 0 }, 1).length, 0);
  assert.equal(neighbours({ z: 3, x: 0, y: 0 }, 1).length, 3);
});
test('radius ten retains only the nearest neighbours allowed by the queue limit', async t => {
  const tile = { z: 8, x: 128, y: 128 }, seen = [];
  const candidates = neighbours(tile, 10);
  assert.equal(candidates.length, 440);
  const prefetch = createPrefetch({ radius: 10, limit: 64, delayMs: 1,
    render: async (_provider, neighbour) => seen.push(neighbour) });
  t.after(() => prefetch.close());
  prefetch.begin('auto', tile)(true);
  assert.equal(prefetch.stats.queued, 64);
  assert.equal(prefetch.stats.queuedZoom, 0, 'nearby tiles retain priority when the queue is full');
  for (let i = 0; i < 200 && (prefetch.stats.queued || prefetch.stats.active); i++) await wait(5);
  assert.deepEqual(seen, candidates.slice(0, 64));
  assert.equal(prefetch.stats.queued, 0);
  assert.equal(prefetch.stats.active, 0);
});
test('neighbour prefetch proceeds during outstanding requests, stays bounded and never expands recursively', async t => {
  const seen = [];
  const prefetch = createPrefetch({ radius: 1, zoom: false, limit: 8, delayMs: 1, render: async (provider, tile) => seen.push(`${provider}/${tile.z}/${tile.x}/${tile.y}`) });
  t.after(() => prefetch.close());
  const tile = { z: 3, x: 4, y: 4 };
  const finish = prefetch.begin('auto', tile), other = prefetch.begin('auto', tile);
  finish(true);
  for (let i = 0; i < 100 && seen.length < 8; i++) await wait(5);
  assert.equal(seen.length, 8); assert.equal(new Set(seen).size, 8);
  assert.equal(prefetch.stats.requests, 1, 'one outstanding request must not block spare workers');
  other(true);
  await wait(15); assert.equal(seen.length, 8);
  prefetch.begin('auto', tile)(true); await wait(15); assert.equal(seen.length, 8);
  for (let x = 1; x < 7; x++) prefetch.begin('auto', { z: 3, x, y: 1 })(true);
  assert.ok(prefetch.stats.queued <= 8);
});
test('zoom prefetch follows queued neighbours without waiting for outstanding requests', async t => {
  const seen = [];
  const prefetch = createPrefetch({ delayMs: 1, concurrency: 3, render: async (_provider, _tile, priority) => seen.push(priority) });
  t.after(() => prefetch.close());
  const pending = prefetch.begin('auto', { z: 6, x: 40, y: 40 });
  prefetch.begin('auto', { z: 6, x: 10, y: 10 })(true);
  for (let i = 0; i < 100 && seen.length < 13; i++) await wait(5);
  assert.equal(seen.length, 13); assert.ok(seen.slice(0, 8).every(priority => priority === 1));
  assert.ok(seen.slice(8).every(priority => priority === 2));
  assert.equal(prefetch.stats.requests, 1, 'an outstanding request must not hold spare prefetch capacity idle');
  pending(false);
});
test('disabled or failed requests do not schedule speculative work', async t => {
  for (const radius of [0, 1]) {
    const prefetch = createPrefetch({ radius, delayMs: 1, render: () => assert.fail('must not prefetch') });
    t.after(() => prefetch.close());
    prefetch.begin('auto', { z: 3, x: 4, y: 4 })(radius === 0);
    await wait(10); assert.equal(prefetch.stats.queued, 0);
  }
});

test('cache maintenance discards pending prefetch and resumes without suppressing recently cleared tiles', async t => {
  const seen = [], tile = { z: 6, x: 10, y: 10 };
  const prefetch = createPrefetch({ radius: 1, zoom: false, delayMs: 1, render: async (_provider, neighbour) => seen.push(neighbour) });
  t.after(() => prefetch.close());
  prefetch.begin('auto', tile)(true);
  for (let i = 0; i < 100 && seen.length < 8; i++) await wait(5);
  assert.equal(seen.length, 8);
  const unfinished = prefetch.begin('auto', tile);
  prefetch.begin('auto', { z: 6, x: 20, y: 20 })(true);
  assert.ok(prefetch.stats.queued);
  prefetch.pause(); unfinished(true);
  assert.equal(prefetch.stats.queued, 0); assert.equal(prefetch.stats.requests, 0);
  await wait(10); assert.equal(seen.length, 8);
  prefetch.resume(); prefetch.begin('auto', tile)(true);
  for (let i = 0; i < 100 && seen.length < 16; i++) await wait(5);
  assert.equal(seen.length, 16);
});

test('zoom prefetch covers one parent and four children within provider limits', () => {
  const tile = { z: 13, x: 7578, y: 4746 };
  assert.deepEqual(zoomNeighbours(tile), [
    { z: 12, x: 3789, y: 2373 },
    { z: 14, x: 15156, y: 9492 }, { z: 14, x: 15157, y: 9492 },
    { z: 14, x: 15156, y: 9493 }, { z: 14, x: 15157, y: 9493 },
  ]);
  assert.equal(zoomNeighbours({ z: 0, x: 0, y: 0 }).length, 4);
  assert.equal(zoomNeighbours({ z: 19, x: 1, y: 1 }).length, 1);
  assert.equal(zoomNeighbours(tile, { minzoom: 13, maxzoom: 13 }).length, 0);
});

test('newest requests win even when old requests finish last; zoom remains lowest', async t => {
  const seen = [], olderTile = { z: 6, x: 10, y: 10 }, newerTile = { z: 6, x: 30, y: 30 };
  const prefetch = createPrefetch({ delayMs: 1, concurrency: 3, render: async (provider, tile, priority) => seen.push({ tile, priority }) });
  t.after(() => prefetch.close());
  const older = prefetch.begin('auto', olderTile), newer = prefetch.begin('auto', newerTile);
  newer(true); older(true);
  for (let i = 0; i < 100 && seen.length < 26; i++) await wait(5);
  assert.equal(seen.length, 26);
  assert.deepEqual(seen.slice(0, 8).map(job => job.tile), neighbours(newerTile, 1));
  assert.deepEqual(seen.slice(8, 16).map(job => job.tile), neighbours(olderTile, 1));
  assert.ok(seen.slice(16).every(job => job.priority === 2));
  assert.deepEqual(seen.slice(16, 21).map(job => job.tile), zoomNeighbours(newerTile));
  await wait(10); assert.equal(seen.length, 26, 'prefetch must not spawn further prefetch');
});

test('overlapping queued neighbours are moved to the new request, and zoom never displaces neighbours', async t => {
  const seen = [];
  const prefetch = createPrefetch({ limit: 8, delayMs: 1, render: async (_provider, tile, priority) => seen.push({ tile, priority }) });
  t.after(() => prefetch.close());
  prefetch.begin('auto', { z: 6, x: 10, y: 10 })(true);
  prefetch.begin('auto', { z: 6, x: 11, y: 10 })(true);
  for (let i = 0; i < 100 && seen.length < 8; i++) await wait(5);
  assert.equal(seen.length, 8);
  assert.deepEqual(seen[0].tile, { z: 6, x: 11, y: 9 });
  assert.ok(seen.every(job => job.priority === 1));
});

test('prefetch fills free slots with zoom while the final neighbours are still running', async t => {
  const seen = [], releases = [];
  const prefetch = createPrefetch({ concurrency: 3, delayMs: 1, render: async (_provider, tile, priority) => {
    seen.push({ tile, priority });
    await new Promise(resolve => releases.push(resolve));
  } });
  t.after(() => prefetch.close());
  prefetch.begin('auto', { z: 6, x: 10, y: 10 })(true);
  for (let i = 0; i < 100 && seen.length < 3; i++) await wait(5);
  assert.equal(seen.length, 3); assert.equal(prefetch.stats.active, 3);
  while (seen.length < 8) {
    releases.shift()();
    const previous = seen.length;
    for (let i = 0; i < 100 && seen.length === previous; i++) await wait(5);
  }
  assert.ok(seen.every(job => job.priority === 1));
  assert.equal(prefetch.stats.completedZoom, 0);
  releases.shift()();
  for (let i = 0; i < 100 && seen.length < 9; i++) await wait(5);
  assert.equal(seen.length, 9, 'the next free slot starts zoom without waiting for all neighbours');
  assert.equal(seen[8].priority, 2);
  assert.equal(prefetch.stats.active, 3, 'two neighbours and one zoom use the configured three slots');
  assert.equal(releases.length, 3);
  for (let i = 0; i < 100 && (prefetch.stats.active || prefetch.stats.queued); i++) {
    while (releases.length) releases.shift()();
    await wait(5);
  }
  assert.equal(seen.length, 13);
  assert.equal(prefetch.stats.completedZoom, 5);
  assert.equal(prefetch.stats.active, 0);
});

test('metatile siblings share admission capacity and retain it until the last sibling settles', async t => {
  const seen = [], releases = [];
  const prefetch = createPrefetch({ radius: 1, zoom: false, concurrency: 1, delayMs: 1,
    groupKey: (_provider, tile) => `${tile.z}/${Math.floor(tile.x / 2)}/${Math.floor(tile.y / 2)}`,
    render: (_provider, tile) => new Promise((resolve, reject) => { seen.push(tile); releases.push({ resolve, reject }); }),
  });
  t.after(() => { prefetch.close(); for (const release of releases) release.resolve(); });
  prefetch.begin('qld', { z: 6, x: 10, y: 10 })(true);
  for (let i = 0; i < 100 && seen.length < 2; i++) await wait(5);
  assert.deepEqual(seen, [{ z: 6, x: 10, y: 9 }, { z: 6, x: 11, y: 9 }], 'a sibling behind other pending grids must still be admitted');
  assert.equal(prefetch.stats.active, 2);
  assert.equal(prefetch.stats.activeGroups, 1);
  assert.equal(prefetch.stats.queued, 6);
  releases.shift().resolve();
  await wait(10);
  assert.equal(seen.length, 2, 'the first tile finishing must not release its still-active grid');
  assert.equal(prefetch.stats.active, 1);
  assert.equal(prefetch.stats.activeGroups, 1);
  assert.equal(prefetch.stats.completed, 1);
  releases.shift().reject(new Error('second tile failed'));
  for (let i = 0; i < 100 && seen.length < 4; i++) await wait(5);
  assert.equal(seen.length, 4, 'the next grid can start after the final sibling rejects');
  assert.equal(prefetch.stats.activeGroups, 1);
  assert.equal(prefetch.stats.completed, 1, 'a failed sibling is not counted as successful');
  prefetch.close();
  while (releases.length) releases.shift().resolve();
  for (let i = 0; i < 100 && prefetch.stats.active; i++) await wait(5);
  assert.equal(prefetch.stats.activeGroups, 0, 'settled siblings leave no occupied groups');
});

test('without a grouping hint prefetch retains per-tile admission limits', async t => {
  const releases = [];
  const prefetch = createPrefetch({ radius: 1, zoom: false, concurrency: 2, delayMs: 1,
    render: () => new Promise(resolve => releases.push(resolve)),
  });
  t.after(() => { prefetch.close(); while (releases.length) releases.shift()(); });
  prefetch.begin('nsw', { z: 6, x: 10, y: 10 })(true);
  for (let i = 0; i < 100 && releases.length < 2; i++) await wait(5);
  assert.equal(prefetch.stats.active, 2);
  assert.equal(prefetch.stats.activeGroups, 2);
  assert.equal(prefetch.stats.queued, 6);
});
