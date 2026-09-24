const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coverage, imageParts } = require('../lib/coverage');
function tile(lng, lat, z = 16) {
  return { z, x: Math.floor((lng + 180) / 360 * 2 ** z), y: Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z) };
}
test('automatic coverage follows the state boundary, including southern QLD and ACT', () => {
  for (const [lng, lat] of [[153.03, -27.47], [151.933, -28.654]]) assert.equal(coverage(tile(lng, lat)).region, 'qld');
  for (const [lng, lat] of [[150.31, -33.72], [152.019, -29.055], [149.13, -35.28]]) assert.equal(coverage(tile(lng, lat)).region, 'nsw');
  const border = coverage(tile(153.539, -28.166, 14));
  assert.equal(border.region, 'border'); assert.ok(border.rings.length);
  assert.equal(coverage({ z: 0, x: 0, y: 0 }).region, 'border', 'low zoom must not lose an entire state inside one tile');
});
test('512px NSW tiles use four native children and overzoom crops the correct parent', () => {
  const t = { z: 13, x: 7516, y: 4911 };
  const parts = imageParts(t, 512);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts[3], { z: 14, x: 15033, y: 9823, source: [0, 0, 256, 256], destination: [256, 256, 256, 256] });
  assert.equal(imageParts(t, 256).length, 1);
  assert.deepEqual(imageParts({ z: 18, x: 240527, y: 157183 }, 512), [{ z: 16, x: 60131, y: 39295, source: [192, 192, 64, 64], destination: [0, 0, 512, 512] }]);
});
