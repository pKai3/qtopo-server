const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkQueue } = require('../lib/queue');
test('bound concurrency and backpressure while releasing failed jobs', async () => {
  const queue = new WorkQueue(1, 1); let release;
  const gate = new Promise(r => release = r); const events = [];
  const first = queue.run(async () => { events.push('first'); await gate; throw new Error('failed'); });
  const firstCheck = assert.rejects(first, /failed/);
  const second = queue.run(async () => { events.push('second'); return 2; });
  await assert.rejects(queue.run(() => 3), { status: 503 });
  assert.deepEqual(queue.stats, { active: 1, queued: 1, concurrency: 1 });
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
  const background = queue.run(() => events.push('background'), { background: true, key: 'neighbour' });
  const promoted = queue.run(() => events.push('promoted'), { background: true, key: 'requested' });
  queue.promote('requested');
  const foreground = queue.run(() => events.push('foreground'));
  await new Promise(resolve => setImmediate(resolve)); release();
  await Promise.all([first, background, promoted, foreground]);
  assert.deepEqual(events, ['promoted', 'foreground', 'background']); queue.close();
});

test('prefetch reserves foreground capacity and cannot fill the foreground queue', async () => {
  const queue = new WorkQueue(2, 1); let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }), { background: true });
  const waiting = queue.run(() => assert.fail('evicted prefetch must not run'), { background: true });
  const rejected = assert.rejects(waiting, { status: 503 });
  assert.equal(queue.stats.active, 1);
  assert.equal(await queue.run(() => 'requested'), 'requested');
  await rejected; release(); await first; queue.close();
});
