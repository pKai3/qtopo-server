const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRenderMemory, readCgroupMemory } = require('../lib/render-memory');
const { WorkQueue, PRIORITY } = require('../lib/queue');
const MIB = 1024 ** 2;
const snapshot = (used, limit = 4096) => ({ limitBytes: limit * MIB, currentBytes: used * MIB, workingBytes: used * MIB });
const admit = (memory, n, workers = [], idle = []) => memory.canStart({ active: Array.from({ length: n }, (_, i) => i < workers.filter(w => w.task).length ? workers.filter(w => w.task)[i].task.job : {}), workers, idle, job: {} });
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
  while (admitted < 16 && admit(memory, admitted, [])) admitted++;
  assert.equal(admitted, 6, '512 MiB reservations and headroom apply to pending slots too');
  assert.equal(memory.stats().limited, true);
  assert.equal(memory.stats().pauses, 1);
});

test('retained memory, active growth and other server memory all reduce admission', () => {
  let used = 500;
  const memory = createRenderMemory({ read: () => snapshot(used) });
  const workers = Array.from({ length: 4 }, () => ({ task: {}, rssBytes: 100 * MIB }));
  assert.equal(admit(memory, 4, workers), true);
  used = 2000;
  assert.equal(admit(memory, 4, workers), false, 'reserve growth even if individual jobs are still small');
  used = 3200;
  assert.equal(admit(memory, 0, []), false, 'parent and retained allocations count even with zero active renders');
  used = 500;
  assert.equal(admit(memory, 0, []), true);
  assert.equal(memory.stats().peakWorkingBytes, 3200 * MIB);
  for (let i = 0; i < 4; i++) memory.observePeak(600 * MIB);
  assert.equal(memory.stats().workerEstimateBytes, 600 * MIB, 'learn peak, not just idle RSS');
  used = 3100;
  assert.equal(admit(memory, 0, []), false);
  assert.equal(admit(memory, 0, [], [{ rssBytes: 500 * MIB }]), true, 'reuse credit is already charged by the container');
});

test('unlimited environments retain configured concurrency; failed readings pause admission until recovery', () => {
  let failure = false;
  const memory = createRenderMemory({ read: () => { if (failure) throw new Error('unreadable'); return snapshot(100); } });
  assert.equal(admit(memory, 0, []), true);
  failure = true;
  assert.equal(admit(memory, 0, []), false);
  assert.equal(memory.stats().readFailed, true);
  failure = false;
  assert.equal(admit(memory, 0, []), true);
  assert.equal(createRenderMemory({ read: () => null }).canStart({ active: Array.from({length:15}, () => ({})) }), true);
  assert.equal(createRenderMemory({ read: () => { throw new Error('unreadable'); } }).canStart(), false);
});

test('a larger container allowance permits the full configured pool after measuring light renders', () => {
  const memory = createRenderMemory({ read: () => snapshot(250, 8192) });
  for (let i = 0; i < 4; i++) memory.observePeak(280 * MIB);
  assert.equal(admit(memory, 15, []), true, 'sixteen 280 MiB reservations fit an 8 GiB container with headroom');
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


test('shared library RSS does not impose a four-worker ceiling on a light workload', () => {
  // Captured phone workload: 140 MiB of file mappings per worker, 240 MiB
  // private peak. The cgroup already includes the shared libraries once.
  const memory = createRenderMemory({ read: () => snapshot(1700) });
  for (let i = 0; i < 8; i++) memory.observePeak(240 * MIB);
  const workers = Array.from({ length: 4 }, () => ({ task: {}, rssBytes: 380 * MIB,
    footprintBytes: 240 * MIB, peakFootprintBytes: 240 * MIB }));
  let admitted = 4;
  while (admitted < 16 && admit(memory, admitted, workers)) admitted++;
  assert.equal(admitted, 11, 'more work starts promptly while all future growth remains reserved');
  assert.equal(memory.stats(workers).workerEstimateBytes, 240 * MIB);
  assert.equal(memory.stats().headroomBytes, 512 * MIB);
});

test('a large active private allocation immediately raises the reservation and blocks further growth', () => {
  const memory = createRenderMemory({ read: () => snapshot(2500) });
  for (let i = 0; i < 8; i++) memory.observePeak(240 * MIB);
  const workers = Array.from({ length: 6 }, () => ({ task: {}, rssBytes: 400 * MIB,
    footprintBytes: 260 * MIB, peakFootprintBytes: 260 * MIB }));
  workers[0].footprintBytes = workers[0].peakFootprintBytes = 600 * MIB;
  assert.equal(admit(memory, 6, workers), false);
  assert.equal(memory.stats(workers).workerEstimateBytes, 600 * MIB);
});


test('background reservations leave room for a requested render under the effective memory cap', () => {
  const memory = createRenderMemory({ read: () => snapshot(250) });
  const active = Array.from({length:5}, () => ({}));
  assert.equal(memory.canStart({ active, job: {}, reserveForeground: true }), false);
  assert.equal(memory.stats().foregroundReserveBytes, 512 * MIB);
  assert.equal(memory.canStart({ active, job: {} }), true, 'the foreground slot is real memory capacity, not only one of sixteen configured slots');
});

test('light foreground tiles can use sixteen workers without inheriting dense zoom-prefetch peaks', () => {
  const memory = createRenderMemory({ read: () => snapshot(400) });
  const light = {kind:'vector',styleKey:'mobile',z:15,size:1024};
  const dense = {...light,z:18};
  for(let i=0;i<4;i++){memory.observePeak(190*MIB,light);memory.observePeak(700*MIB,dense);}
  assert.equal(memory.canStart({active:Array.from({length:15},()=>({...light})),job:light}),true);
  assert.equal(memory.canStart({active:Array.from({length:4},()=>({...dense})),job:dense}),false);
});

test('pending warm admissions credit each distinct idle worker only once', () => {
  const memory = createRenderMemory({ read: () => snapshot(2600) });
  for(let i=0;i<4;i++)memory.observePeak(400*MIB,{});
  const active = [{},{},{}], idle = Array.from({length:4},()=>({footprintBytes:250*MIB}));
  assert.equal(memory.canStart({active,idle,job:{}}),true);
  assert.equal(memory.stats().reservedBytes,600*MIB);
  assert.equal(memory.canStart({active,idle:idle.slice(0,2),job:{}}),false,'two idle workers cannot be credited against four admitted jobs');
});


test('pending jobs reserve enough memory even if asynchronous dispatch swaps warm workers', () => {
  const memory = createRenderMemory({ read: () => snapshot(2700) });
  const light = {z:15}, dense = {z:18};
  for (let i = 0; i < 4; i++) { memory.observePeak(200 * MIB, light); memory.observePeak(700 * MIB, dense); }
  const idle = [{footprintBytes:600 * MIB}, {footprintBytes:100 * MIB}];
  assert.equal(memory.canStart({active:[light], job:dense, idle}), true);
  assert.equal(memory.stats().reservedBytes, 600 * MIB, 'reserve for the dense job taking the smaller warm worker');
});
