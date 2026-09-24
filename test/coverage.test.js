const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coverage } = require('../lib/coverage');
function tile(lng, lat, z = 16) {
  return { z, x: Math.floor((lng + 180) / 360 * 2 ** z), y: Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z) };
}
test('automatic coverage follows the state boundary, including southern QLD and ACT', () => {
  for (const [lng, lat] of [[153.03, -27.47], [151.933, -28.654]]) assert.equal(coverage(tile(lng, lat)).region, 'qld');
  for (const [lng, lat] of [[150.31, -33.72], [152.019, -29.055], [149.13, -35.28], [153.54, -28.186], [151.32, -33.87]]) assert.equal(coverage(tile(lng, lat)).region, 'nsw');
  const border = coverage(tile(153.539, -28.166, 14));
  assert.equal(border.region, 'border'); assert.ok(border.rings.length);
  assert.equal(coverage({ z: 0, x: 0, y: 0 }).region, 'border', 'low zoom must not lose an entire state inside one tile');
});
