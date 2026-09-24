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
test('prefetch waits for requests, stays bounded, deduplicates and never expands recursively', async t => {
  const seen = [];
  const prefetch = createPrefetch({ radius: 1, zoom: false, limit: 8, delayMs: 1, render: async (provider, tile) => seen.push(`${provider}/${tile.z}/${tile.x}/${tile.y}`) });
  t.after(() => prefetch.close());
  const tile = { z: 3, x: 4, y: 4 };
  const finish = prefetch.begin('auto', tile), other = prefetch.begin('auto', tile);
  finish(true); await wait(15); assert.equal(seen.length, 0);
  other(true);
  for (let i = 0; i < 100 && seen.length < 8; i++) await wait(5);
  assert.equal(seen.length, 8); assert.equal(new Set(seen).size, 8);
  await wait(15); assert.equal(seen.length, 8);
  prefetch.begin('auto', tile)(true); await wait(15); assert.equal(seen.length, 8);
  for (let x = 1; x < 7; x++) prefetch.begin('auto', { z: 3, x, y: 1 })(true);
  assert.ok(prefetch.stats.queued <= 8);
});
test('disabled or failed requests do not schedule speculative work', async t => {
  for (const radius of [0, 1]) {
    const prefetch = createPrefetch({ radius, delayMs: 1, render: () => assert.fail('must not prefetch') });
    t.after(() => prefetch.close());
    prefetch.begin('auto', { z: 3, x: 4, y: 4 })(radius === 0);
    await wait(10); assert.equal(prefetch.stats.queued, 0);
  }
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

test('prefetch uses available concurrency but waits for all neighbours before zoom', async t => {
  const seen = [], releases = [];
  const prefetch = createPrefetch({ concurrency: 3, delayMs: 1, render: async (_provider, tile, priority) => {
    seen.push({ tile, priority });
    if (priority === 1) await new Promise(resolve => releases.push(resolve));
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
  while (releases.length) releases.shift()();
  for (let i = 0; i < 100 && seen.length < 13; i++) await wait(5);
  assert.equal(seen.length, 13);
});
