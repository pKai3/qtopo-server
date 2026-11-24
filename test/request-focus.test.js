const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequestFocus, rememberInterest } = require('../lib/request-focus');
const { WorkQueue, PRIORITY } = require('../lib/queue');

test('disabling pan/zoom reprioritization keeps requested arrival order across jumps on a shared IP', async () => {
  const focus = createRequestFocus({ reprioritize: false }), queue = new WorkQueue(1, 8, 1, () => false);
  const first = { z: 12, x: 100, y: 100 }, pan = { z: 12, x: 150, y: 150 }, zoom = { z: 14, x: 600, y: 600 };
  const order = [];
  const enqueue = (name, tile, priority = PRIORITY.REQUEST) => {
    const interest = focus.observe('shared-ip', tile).forTile(tile);
    return queue.run(() => order.push(name), { priority, score: interest.score });
  };
  const tasks = [enqueue('prefetch', first, PRIORITY.ZOOM), enqueue('first', first), enqueue('pan', pan), enqueue('zoom', zoom)];
  queue.canStart = () => true; queue.drain(); await Promise.all(tasks);
  assert.deepEqual(order, ['first', 'pan', 'zoom', 'prefetch']);
  queue.close();
});

test('small pans keep the area anchor; large and gradual pans move it in tile units', () => {
  const focus = createRequestFocus({ distance: 8 });
  const old = { z: 12, x: 100, y: 100 };
  const interest = focus.observe('a', old).forTile(old);
  focus.observe('a', { ...old, x: 108 });
  assert.equal(interest.score(), 2, 'the threshold itself keeps the original area');
  const distant = { ...old, x: 109 };
  const newest = focus.observe('a', distant).forTile(distant);
  assert.equal(interest.score(), 1, 'distance is from the area anchor, not the previous adjacent tile');
  assert.equal(newest.score(), 2);
});

test('zoom changes reprioritize all existing interests and each client keeps its own focus', () => {
  const focus = createRequestFocus();
  const tile = { z: 12, x: 100, y: 100 }, zoomed = { z: 13, x: 200, y: 200 };
  const first = focus.observe('a', tile).forTile(tile);
  const other = focus.observe('b', tile).forTile(tile);
  const second = focus.observe('a', zoomed).forTile(zoomed);
  assert.deepEqual([first.score(), other.score(), second.score()], [0, 2, 2]);
  focus.observe('a', tile);
  assert.deepEqual([first.score(), other.score(), second.score()], [2, 2, 0]);
});

test('idle and excess client state expires, including interests retained by shared work', () => {
  let time = 0;
  const focus = createRequestFocus({ ttlMs: 100, limit: 2, now: () => time });
  const tile = { z: 12, x: 100, y: 100 }, interests = new Map();
  const first = focus.observe('a', tile).forTile(tile);
  rememberInterest(interests, first);
  rememberInterest(interests, focus.observe('b', tile).forTile(tile));
  rememberInterest(interests, focus.observe('c', tile).forTile(tile));
  assert.equal(first.score(), 0);
  assert.equal(interests.size, 2);
  time = 100;
  rememberInterest(interests, focus.observe('d', tile).forTile(tile));
  assert.equal(interests.size, 1);
});
