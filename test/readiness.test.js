const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readiness } = require('../lib/readiness');

test('idle and briefly busy services are ready without requiring live upstream probes', () => {
  assert.equal(readiness().ready, true);
  assert.equal(readiness({ renderer: { consecutiveFailures: 2, queued: 5, oldestQueuedMs: 500 } }).ready, true);
});
test('repeated rendering and provider failures are distinguished and clear after success', () => {
  const data = { renderer: { consecutiveFailures: 3 }, cache: { providers: { nsw: { consecutiveFailures: 3 }, qld: { consecutiveFailures: 0 } } } };
  assert.deepEqual(readiness(data).reasons.map(reason => reason.code), ['render-failures', 'resources-nsw']);
  data.renderer.consecutiveFailures = 0; data.cache.providers.nsw.consecutiveFailures = 0;
  assert.equal(readiness(data).ready, true);
});
test('storage, memory, prolonged queue stalls and maintenance report actionable degradation', () => {
  const result = readiness({ storage: { pressure: true }, renderer: { memory: { readFailed: true }, queued: 1, oldestQueuedMs: 120000 }, maintenance: true });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons.map(reason => reason.code), ['maintenance', 'storage-pressure', 'memory-check-failed', 'render-queue-stalled']);
  assert.equal(readiness({ storage: { readFailed: true } }).reasons[0].code, 'storage-check-failed');
});
