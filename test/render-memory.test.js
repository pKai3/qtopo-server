const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRenderMemory, readCgroupMemory } = require('../lib/render-memory');
const { WorkQueue, PRIORITY } = require('../lib/queue');
const MIB = 1024 ** 2;
const snapshot = (used, limit = 4096) => ({ limitBytes: limit * MIB, currentBytes: used * MIB, workingBytes: used * MIB });
const reader = files => file => {
  if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return files[file];
};

test('read real container limits and exclude only reclaimable inactive file cache', () => {
  for (const v2 of [true, false]) {
    const prefix = v2 ? '/sys/fs/cgroup/' : '/sys/fs/cgroup/memory/';
    const actual = readCgroupMemory(reader({
      [prefix + (v2 ? 'memory.max' : 'memory.limit_in_bytes')]: String(4096 * MIB),
      [prefix + (v2 ? 'memory.current' : 'memory.usage_in_bytes')]: String(3500 * MIB),
      [prefix + 'memory.stat']: `anon ${2800 * MIB}\n${v2 ? 'inactive_file' : 'total_inactive_file'} ${500 * MIB}\n`,
    }));
    assert.deepEqual(actual, { ...snapshot(3000), currentBytes: 3500 * MIB });
  }
  assert.equal(readCgroupMemory(reader({ '/sys/fs/cgroup/memory.max': 'max' })), null);
  assert.equal(readCgroupMemory(reader({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' })), null);
  assert.equal(readCgroupMemory(reader({})), null);
  assert.throws(() => readCgroupMemory(reader({ '/sys/fs/cgroup/memory.max': 'broken' })), /Invalid/);
});

test('a cold burst reserves memory before asynchronous workers start', () => {
  const memory = createRenderMemory({ read: () => snapshot(250) });
  let admitted = 0;
  while (admitted < 16 && memory.canStart(admitted, [])) admitted++;
  assert.equal(admitted, 5, '512 MiB reservations and 20% headroom apply to pending slots too');
  assert.equal(memory.stats().limited, true);
  assert.equal(memory.stats().pauses, 1);
});

test('retained memory, active growth and other server memory all reduce admission', () => {
  let used = 500;
  const memory = createRenderMemory({ read: () => snapshot(used) });
  const workers = Array.from({ length: 4 }, () => ({ task: {}, rssBytes: 100 * MIB }));
  assert.equal(memory.canStart(4, workers), true);
  used = 2000;
  assert.equal(memory.canStart(4, workers), false, 'reserve growth even if individual jobs are still small');
  used = 3200;
  assert.equal(memory.canStart(0, []), false, 'parent and retained allocations count even with zero active renders');
  used = 500;
  assert.equal(memory.canStart(0, []), true);
  assert.equal(memory.stats().peakWorkingBytes, 3200 * MIB);
  for (let i = 0; i < 4; i++) memory.observePeak(600 * MIB);
  assert.equal(memory.stats().workerEstimateBytes, 750 * MIB, 'learn peak, not just idle RSS');
  used = 2600;
  assert.equal(memory.canStart(0, []), false);
  assert.equal(memory.canStart(0, [{ rssBytes: 500 * MIB }], 500 * MIB), true, 'reuse credit is already charged by the container');
});

test('unlimited environments retain configured concurrency; failed readings pause admission until recovery', () => {
  let failure = false;
  const memory = createRenderMemory({ read: () => { if (failure) throw new Error('unreadable'); return snapshot(100); } });
  assert.equal(memory.canStart(0, []), true);
  failure = true;
  assert.equal(memory.canStart(0, []), false);
  assert.equal(memory.stats().readFailed, true);
  failure = false;
  assert.equal(memory.canStart(0, []), true);
  assert.equal(createRenderMemory({ read: () => null }).canStart(15, []), true);
  assert.equal(createRenderMemory({ read: () => { throw new Error('unreadable'); } }).canStart(0, []), false);
});

test('a larger container allowance permits the full configured pool after measuring light renders', () => {
  const memory = createRenderMemory({ read: () => snapshot(250, 8192) });
  for (let i = 0; i < 4; i++) memory.observePeak(280 * MIB);
  assert.equal(memory.canStart(15, []), true, 'sixteen 350 MiB reservations fit an 8 GiB container with headroom');
});

test('memory-paused queues resume requested work ahead of background work', async () => {
  let available = false;
  const queue = new WorkQueue(16, 8, 15, () => available);
  const order = [];
  const tasks = [
    queue.run(() => order.push('zoom'), { priority: PRIORITY.ZOOM }),
    queue.run(() => order.push('nearby'), { priority: PRIORITY.NEIGHBOUR }),
    queue.run(() => order.push('requested')),
  ];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, []);
  assert.equal(queue.active, 0);
  available = true; queue.drain(); await Promise.all(tasks);
  assert.deepEqual(order, ['requested', 'nearby', 'zoom']);
  queue.close();
});
