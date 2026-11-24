const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../lib/config');

test('storage and request limits use the chosen defaults and are independently configurable', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.cacheMaxBytes, 20 * 1024 ** 3);
  assert.equal(defaults.cacheMinFreeBytes, 5 * 1024 ** 3);
  assert.equal(defaults.requestTimeoutMs, 120000);
  const custom = loadConfig({ CACHE_MAX_GIB: '0', CACHE_MIN_FREE_GIB: '2.5', REQUEST_TIMEOUT_SECONDS: '240', CACHE_CHECK_INTERVAL_SECONDS: '10' });
  assert.equal(custom.cacheMaxBytes, 0); assert.equal(custom.cacheMinFreeBytes, 2.5 * 1024 ** 3);
  assert.equal(custom.requestTimeoutMs, 240000); assert.equal(custom.cacheCheckIntervalMs, 10000);
  for (const [key, value] of [['CACHE_MAX_GIB', '-1'], ['CACHE_MIN_FREE_GIB', 'NaN'], ['REQUEST_TIMEOUT_SECONDS', '0'], ['CACHE_CHECK_INTERVAL_SECONDS', '0']]) {
    assert.throws(() => loadConfig({ [key]: value }), new RegExp(key));
  }
});
