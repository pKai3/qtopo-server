const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readProcessMemory, createJobMemory } = require('../lib/process-memory');
const MIB = 1024 ** 2;

test('worker reservations exclude file mappings while retaining anonymous and shared-memory charges', () => {
  assert.deepEqual(readProcessMemory(42, () => 'VmRSS: 409600 kB\nRssAnon: 256000 kB\nRssFile: 143360 kB\nRssShmem: 10240 kB\n'),
    { rssBytes: 400 * MIB, footprintBytes: 260 * MIB });
  assert.deepEqual(readProcessMemory(42, () => 'VmRSS: 409600 kB\n'),
    { rssBytes: 400 * MIB, footprintBytes: 400 * MIB });
  assert.throws(() => readProcessMemory(42, () => ''), /Invalid/);
});

test('a heavy previous render does not become the next job peak after memory is released', () => {
  let current = { rssBytes: 400 * MIB, footprintBytes: 260 * MIB };
  const first = createJobMemory(() => current);
  first.sample();
  current = { rssBytes: 700 * MIB, footprintBytes: 560 * MIB };
  first.sample();
  current = { rssBytes: 300 * MIB, footprintBytes: 160 * MIB };
  assert.equal(first.sample().peakFootprintBytes, 560 * MIB);
  const next = createJobMemory(() => current);
  assert.equal(next.sample().peakFootprintBytes, 160 * MIB);
  current = { rssBytes: 390 * MIB, footprintBytes: 250 * MIB };
  assert.equal(next.sample().peakFootprintBytes, 250 * MIB);
});
