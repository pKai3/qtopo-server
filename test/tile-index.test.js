const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveIndex } = require('../lib/tile-index');
test('indexed vector leaves supply parents and empty branches never become downloads', () => {
  const index = [0, 1, [1, 0, 1, 1], [1, 1, 1, 1]];
  assert.equal(resolveIndex(index, { z: 4, x: 15, y: 0 }), 1);
  assert.equal(resolveIndex(index, { z: 4, x: 0, y: 0 }), null);
  assert.equal(resolveIndex(index, { z: 4, x: 0, y: 15 }), 2);
  assert.equal(resolveIndex(index, { z: 1, x: 1, y: 1 }), 1);
  assert.equal(resolveIndex(index, { z: 0, x: 0, y: 0 }), 0);
  assert.throws(() => resolveIndex([0, 2, 0, 0], { z: 2, x: 3, y: 0 }), /Unsupported/);
});
