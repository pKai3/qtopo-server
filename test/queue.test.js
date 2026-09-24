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
