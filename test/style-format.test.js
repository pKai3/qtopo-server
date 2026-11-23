const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatStyleJson } = require('../lib/style-format');

test('formatted profiles preserve expressions, escaping, key order and drawing order', () => {
  const style = { version: 8, sources: { qld: { type: 'vector', tiles: ['/vector/{z}/{x}/{y}.pbf'] } }, layers: [
    { id: 'a', type: 'line', source: 'qld', 'source-layer': 'Contour', minzoom: 14,
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.2, 18, 1] } },
    { id: 'a longer id', type: 'line', source: 'qld', 'source-layer': 'Contour', minzoom: 15,
      paint: { 'line-color': '#62412c' }, metadata: { text: '× "quoted", {braces}\nnext line', empty: null } },
  ] };
  const profile = { format: 1, id: 'mobile-3x', styles: { qld: style, nsw: { version: 8, sources: {}, layers: [] } } };
  const formatted = formatStyleJson(profile), parsed = JSON.parse(formatted);
  assert.equal(JSON.stringify(parsed), JSON.stringify(profile), 'cache-key input must stay byte-for-byte identical');
  assert.equal(formatStyleJson(parsed), formatted, 'formatting is idempotent');
  const rows = formatted.split('\n').filter(row => row.trimStart().startsWith('{ "id":'));
  assert.equal(rows.length, 2);
  for (const key of ['type', 'source', 'source-layer', 'minzoom', 'paint']) {
    assert.equal(rows[0].indexOf(`"${key}":`), rows[1].indexOf(`"${key}":`));
  }
});
