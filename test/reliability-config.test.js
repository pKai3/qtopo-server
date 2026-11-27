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

test('NSW contour preparation starts at boot with retained storage outside disposable caches', () => {
  const defaults = loadConfig({ DATA_DIR: '/data' });
  assert.equal(defaults.nswContoursEnabled, true);
  assert.equal(defaults.nswContoursDir, '/data/contours/nsw');
  assert.equal(defaults.nswContoursThreads, 2);
  assert.equal(defaults.nswContoursRetryMs, 60000);
  const custom = loadConfig({ DATA_DIR: '/data', NSW_CONTOURS_ENABLED: '0', NSW_CONTOURS_DIR: '/retained/nsw', NSW_CONTOURS_THREADS: '4', NSW_CONTOURS_RETRY_SECONDS: '120' });
  assert.equal(custom.nswContoursEnabled, false);
  assert.equal(custom.nswContoursDir, '/retained/nsw');
  assert.equal(custom.nswContoursThreads, 4);
  assert.equal(custom.nswContoursRetryMs, 120000);
  for (const directory of ['/data', '/data/vector', '/data/vector/v2/nsw', '/data/resources']) {
    assert.throws(() => loadConfig({ DATA_DIR: '/data', NSW_CONTOURS_DIR: directory }), /separate from disposable/);
  }
  for (const [key, value] of [['NSW_CONTOURS_ENABLED', 'yes'], ['NSW_CONTOURS_THREADS', '0'], ['NSW_CONTOURS_THREADS', '9'], ['NSW_CONTOURS_RETRY_SECONDS', '0']]) {
    assert.throws(() => loadConfig({ [key]: value }), new RegExp(key));
  }
});
