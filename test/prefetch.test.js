const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPrefetch, neighbours, zoomNeighbours } = require('../lib/prefetch');
const { createRequestFocus } = require('../lib/request-focus');
const turn = () => new Promise(resolve => setImmediate(resolve));
const tile = { z: 8, x: 100, y: 100 };

test('candidate geometry stays inside XYZ bounds and visits nearest neighbours first', () => {
  assert.equal(neighbours(tile, 1).length, 8);
  assert.equal(neighbours({ z: 0, x: 0, y: 0 }, 1).length, 0);
  assert.equal(neighbours({ z: 3, x: 0, y: 0 }, 1).length, 3);
  assert.deepEqual(zoomNeighbours(tile), [{ z: 7, x: 50, y: 50 },
    { z: 9, x: 200, y: 200 }, { z: 9, x: 201, y: 200 }, { z: 9, x: 200, y: 201 }, { z: 9, x: 201, y: 201 }]);
  assert.equal(zoomNeighbours(tile, { minzoom: 8, maxzoom: 8 }).length, 0);
});

test('prefetch submits directly to the shared scheduler with no second waiting queue or admission budget', async t => {
  const seen = [], releases = [];
  const prefetch = createPrefetch({ render: (_provider, tile, priority) => new Promise(resolve => {
    seen.push({ tile, priority }); releases.push(resolve);
  }) });
  t.after(() => { prefetch.close(); releases.forEach(resolve => resolve()); });
  const outstanding = prefetch.begin('qld', tile);
  prefetch.begin('qld', tile)(true);
  await turn();
  assert.equal(seen.length, 13, 'every candidate reaches the shared scheduler immediately');
  assert.ok(seen.slice(0, 8).every(job => job.priority === 1));
  assert.ok(seen.slice(8).every(job => job.priority === 2));
  assert.equal(prefetch.stats.queued, undefined);
  assert.equal(prefetch.stats.tracked, 13);
  outstanding(true); await turn(); assert.equal(seen.length, 13, 'shared candidates are deduplicated');
  releases.forEach(resolve => resolve()); await turn();
  assert.equal(prefetch.stats.tracked, 0); assert.equal(prefetch.stats.completed, 13);
  prefetch.begin('qld', tile)(true); await turn(); assert.equal(seen.length, 13, 'completed candidates are suppressed briefly');
});

test('large-radius bursts are bounded and do not recursively expand', async t => {
  const seen = [];
  const prefetch = createPrefetch({ radius: 10, limit: 64, render: async (_provider, tile) => seen.push(tile) });
  t.after(() => prefetch.close());
  prefetch.begin('qld', tile)(true); await turn();
  assert.deepEqual(seen, neighbours(tile, 10).slice(0, 64));
  await turn(); assert.equal(seen.length, 64);
});

test('a new view cancels obsolete candidates and late responses cannot refill the old view', async t => {
  const focus = createRequestFocus(), signals = [], seen = [];
  const prefetch = createPrefetch({ zoom: false, render: (_provider, tile, _priority, _rank, interest) => {
    signals.push(interest.signal); seen.push(tile);
    return new Promise((resolve, reject) => interest.signal.addEventListener('abort', () => reject(interest.signal.reason), { once: true }));
  } });
  t.after(() => prefetch.close());
  const old = focus.observe('a', tile), late = prefetch.begin('qld', tile, old);
  prefetch.begin('qld', tile, old)(true); await turn();
  focus.observe('a', { ...tile, x: 130 }); prefetch.sweep();
  assert.ok(signals.every(signal => signal.aborted));
  late(true); await turn();
  assert.equal(seen.length, 8); assert.equal(prefetch.stats.cancelled, 8);
});

test('shared speculation survives until every interested client leaves', async t => {
  const focus = createRequestFocus(), interests = [];
  const prefetch = createPrefetch({ zoom: false, render: (_provider, _tile, _priority, _rank, interest) => {
    interests.push(interest);
    return new Promise((resolve, reject) => interest.signal.addEventListener('abort', () => reject(interest.signal.reason), { once: true }));
  } });
  t.after(() => prefetch.close());
  prefetch.begin('qld', tile, focus.observe('a', tile))(true);
  prefetch.begin('qld', tile, focus.observe('b', tile))(true); await turn();
  assert.equal(interests.length, 8); assert.deepEqual(interests[0].clients(), [1, 2]);
  focus.observe('a', { ...tile, z: 9 }); prefetch.sweep();
  assert.ok(interests.every(interest => !interest.signal.aborted));
  focus.observe('b', { ...tile, x: 130 }); prefetch.sweep();
  assert.ok(interests.every(interest => interest.signal.aborted));
});

test('disabled reprioritization keeps old-view work; pausing still cancels it and resume clears recent cache checks', async t => {
  const focus = createRequestFocus({ reprioritize: false }), interests = [];
  const prefetch = createPrefetch({ zoom: false, render: async (_p, _t, _priority, _rank, interest) => { interests.push(interest); } });
  t.after(() => prefetch.close());
  prefetch.begin('qld', tile, focus.observe('a', tile))(true); await turn();
  focus.observe('a', { ...tile, z: 9 });
  assert.ok(interests.every(interest => interest.wanted()));
  prefetch.pause(); prefetch.begin('qld', tile)(true); await turn(); assert.equal(interests.length, 8);
  prefetch.resume(); prefetch.begin('qld', tile)(true); await turn(); assert.equal(interests.length, 16);
});

test('disabled prefetch and failed requests do not create work', async t => {
  for (const radius of [0, 1]) {
    const prefetch = createPrefetch({ radius, render: () => assert.fail('must not prefetch') });
    t.after(() => prefetch.close());
    prefetch.begin('qld', tile)(radius === 0); await turn();
    assert.equal(prefetch.stats.tracked, 0);
  }
});

test('a new nearby interest promotes an already-submitted zoom candidate without duplicate work', async t => {
  const focus = createRequestFocus(), interests = new Map();
  const prefetch = createPrefetch({ render: (_p, tile, _priority, _rank, interest) => {
    interests.set(`${tile.z}/${tile.x}/${tile.y}`, interest);
    return new Promise((resolve, reject) => interest.signal.addEventListener('abort', () => reject(interest.signal.reason), { once: true }));
  } });
  t.after(() => prefetch.close());
  prefetch.begin('qld', tile, focus.observe('a', tile))(true); await turn();
  const parent = interests.get('7/50/50'); assert.equal(parent.priority(), 2);
  let updates = 0; parent.subscribe(() => updates++);
  const next = { z: 7, x: 51, y: 50 };
  prefetch.begin('qld', next, focus.observe('b', next))(true); await turn();
  assert.equal(interests.get('7/50/50'), parent);
  assert.equal(parent.priority(), 1); assert.equal(updates, 1);
});

test('zooming into a prefetched child preserves that work while the foreground request discovers its style', async t => {
  const focus = createRequestFocus(), interests = new Map();
  const prefetch = createPrefetch({ render: (_p, tile, _priority, _rank, interest) => {
    interests.set(`${tile.z}/${tile.x}/${tile.y}`, interest);
    return new Promise((resolve, reject) => interest.signal.addEventListener('abort', () => reject(interest.signal.reason), { once: true }));
  } });
  t.after(() => prefetch.close());
  prefetch.begin('qld', tile, focus.observe('a', tile))(true); await turn();
  focus.observe('a', { z: 9, x: 200, y: 200 }); prefetch.sweep();
  assert.equal(interests.get('9/200/200').signal.aborted, false);
  assert.equal(interests.get('7/50/50').signal.aborted, true);
});
