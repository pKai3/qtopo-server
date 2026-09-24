const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTimings, createRequestMetrics } = require('../lib/metrics');
test('timing percentiles use a bounded recent window and report no-data separately', () => {
  const timings = createTimings(['ms'], 10);
  assert.equal(timings.stats.ms.p95, null);
  for (let ms = 1; ms <= 100; ms++) timings.record({ ms });
  assert.equal(timings.stats.count, 100); assert.equal(timings.stats.samples, 10);
  assert.deepEqual(timings.stats.ms, { p50: 95, p95: 100 });
});
test('request metrics count responses once and exclude failures from cached success timing', () => {
  const metrics = createRequestMetrics();
  const first = metrics.begin(), failed = metrics.begin(), closed = metrics.begin();
  metrics.prefetched({ path: '/tile', hit: false });
  first.ready({ path: '/tile', hit: true }); first.finish(200, false, 100);
  first.finish(200, true); failed.finish(502, false); closed.finish(200, true);
  const stats = metrics.stats;
  assert.equal(stats.active, 0); assert.equal(stats.completed, 1); assert.equal(stats.errors, 1);
  assert.equal(stats.disconnected, 1); assert.equal(stats.bytes, 100); assert.equal(stats.hitPercent, 100);
  assert.equal(stats.prefetchUsed, 1); assert.equal(stats.cachedTimings.samples, 1);
});
