const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkQueue, PRIORITY } = require('../lib/queue');
test('bound concurrency and backpressure while releasing failed jobs', async () => {
  const queue = new WorkQueue(1, 1); let release;
  const gate = new Promise(r => release = r); const events = [];
  const first = queue.run(async () => { events.push('first'); await gate; throw new Error('failed'); });
  const firstCheck = assert.rejects(first, /failed/);
  const second = queue.run(async () => { events.push('second'); return 2; });
  await assert.rejects(queue.run(() => 3), { status: 503 });
  assert.equal(queue.stats.active, 1); assert.equal(queue.stats.queued, 1); assert.equal(queue.stats.concurrency, 1);
  release(); await firstCheck; assert.equal(await second, 2); assert.deepEqual(events, ['first', 'second']); queue.close();
});
test('shutdown rejects waiting work', async () => {
  const queue = new WorkQueue(1, 1); let release; const first = queue.run(() => new Promise(r => release = r));
  const second = queue.run(() => 2); const check = assert.rejects(second, { status: 503 });
  await new Promise(r => setImmediate(r)); queue.close(); release(); await first; await check;
  await assert.rejects(queue.run(() => 3), { status: 503 });
});

test('foreground overtakes prefetch and may promote a queued neighbour', async () => {
  const queue = new WorkQueue(1, 4), events = []; let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }));
  const background = queue.run(() => events.push('background'), { priority: PRIORITY.NEIGHBOUR, key: 'neighbour' });
  const promoted = queue.run(() => events.push('promoted'), { priority: PRIORITY.NEIGHBOUR, key: 'requested' });
  queue.promote('requested');
  const foreground = queue.run(() => events.push('foreground'));
  await new Promise(resolve => setImmediate(resolve)); release();
  await Promise.all([first, background, promoted, foreground]);
  assert.deepEqual(events, ['promoted', 'foreground', 'background']); queue.close();
});

test('prefetch reserves foreground capacity and cannot fill the foreground queue', async () => {
  const queue = new WorkQueue(2, 1); let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }), { priority: PRIORITY.NEIGHBOUR });
  const waiting = queue.run(() => assert.fail('evicted prefetch must not run'), { priority: PRIORITY.NEIGHBOUR });
  const rejected = assert.rejects(waiting, { status: 503 });
  assert.equal(queue.stats.active, 1);
  assert.equal(await queue.run(() => 'requested'), 'requested');
  await rejected; release(); await first; queue.close();
});

test('seven background renders can run with an eighth slot reserved, and zoom waits', async () => {
  const queue = new WorkQueue(8, 16), releases = [];
  const nearby = Array.from({ length: 7 }, () => queue.run(() => new Promise(resolve => releases.push(resolve)), { priority: PRIORITY.NEIGHBOUR }));
  let zoomStarted = false;
  const zoom = queue.run(() => { zoomStarted = true; }, { priority: PRIORITY.ZOOM });
  assert.equal(await queue.run(() => 'foreground'), 'foreground');
  assert.equal(queue.stats.peakActive, 8);
  assert.equal(zoomStarted, false);
  for (const release of releases) release();
  await Promise.all([...nearby, zoom]); assert.equal(zoomStarted, true); queue.close();
});

test('queued prefetch honours recency without raising zoom above neighbours', async () => {
  const queue = new WorkQueue(1, 8), seen = []; let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }));
  const old = queue.run(() => seen.push('old neighbour'), { priority: PRIORITY.NEIGHBOUR, rank: 1 });
  const zoom = queue.run(() => seen.push('zoom'), { priority: PRIORITY.ZOOM, rank: 100 });
  const recent = queue.run(() => seen.push('new neighbour'), { priority: PRIORITY.NEIGHBOUR, rank: 2 });
  const requested = queue.run(() => seen.push('requested'));
  await new Promise(resolve => setImmediate(resolve)); release();
  await Promise.all([first, old, zoom, recent, requested]);
  assert.deepEqual(seen, ['requested', 'new neighbour', 'old neighbour', 'zoom']); queue.close();
});

test('a full prefetch queue drops an older location to admit the latest one', async () => {
  const queue = new WorkQueue(1, 1); let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }));
  const old = queue.run(() => assert.fail('old prefetch should be dropped'), { priority: PRIORITY.NEIGHBOUR, rank: 1 });
  const rejected = assert.rejects(old, { status: 503 });
  const latest = queue.run(() => 'latest', { priority: PRIORITY.NEIGHBOUR, rank: 2 });
  await new Promise(resolve => setImmediate(resolve)); release();
  await first; await rejected; assert.equal(await latest, 'latest'); queue.close();
});
