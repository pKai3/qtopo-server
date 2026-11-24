const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVectorValues } = require('../lib/vector-values');

async function fixture(empty = true) {
  const { PbfWriter, PbfReader } = await import('pbf');
  const { VectorTile } = await import('@mapbox/vector-tile');
  const writer = new PbfWriter();
  writer.writeMessage(3, (_, layer) => {
    layer.writeStringField(1, 'contours');
    layer.writeVarintField(15, 2);
    layer.writeVarintField(5, 4096);
    for (const [id, tags] of [[27, [0, 0, 1, 1, 2, 2, 3, 0, 4, 0]], [28, [0, 2, 1, 1]]]) {
      layer.writeMessage(2, (_, feature) => {
        feature.writeVarintField(1, id);
        feature.writePackedVarint(2, tags);
        feature.writeVarintField(3, 2);
        feature.writePackedVarint(4, [9, 20, 40, 10, 4, 6]);
      });
    }
    for (const key of ['_symbol', '_name', 'index', 'note', '_label_class']) layer.writeStringField(3, key);
    layer.writeMessage(4, (_, value) => { if (!empty) value.writeVarintField(4, 0); });
    layer.writeMessage(4, (_, value) => value.writeStringField(1, '1203'));
    layer.writeMessage(4, (_, value) => value.writeVarintField(4, 1));
  });
  return { buffer: Buffer.from(writer.finish()), decode: buffer => new VectorTile(new PbfReader(buffer)) };
}
test('empty Esri values no longer make the browser reject an entire tile', async () => {
  const { buffer, decode } = await fixture();
  assert.throws(() => decode(buffer), /unknown feature value/);
  const repaired = normalizeVectorValues(buffer), tile = decode(repaired), layer = tile.layers.contours;
  assert.equal(layer.length, 2);
  assert.equal(layer.extent, 4096);
  assert.equal(layer.version, 2);
  assert.deepEqual({ ...layer.feature(0).properties }, { _symbol: 0, _name: '1203', index: 1, _label_class: 0 });
  assert.deepEqual({ ...layer.feature(1).properties }, { _symbol: 1, _name: '1203' });
  assert.equal(layer.feature(0).id, 27);
  assert.equal(layer.feature(1).id, 28);
  assert.equal(layer.feature(0).type, 2);
  assert.deepEqual(layer.feature(0).loadGeometry().map(line => line.map(p => [p.x, p.y])), [[[10, 20], [12, 23]]]);
  assert.strictEqual(normalizeVectorValues(repaired), repaired, 'normalization is idempotent');
});
test('valid zero values and already valid tiles remain byte-for-byte unchanged', async () => {
  const { buffer, decode } = await fixture(false);
  assert.strictEqual(normalizeVectorValues(buffer), buffer);
  assert.equal(decode(buffer).layers.contours.feature(0).properties._symbol, 0);
});
test('truncated tile data fails rather than returning a corrupted tile', async () => {
  const { buffer } = await fixture();
  assert.throws(() => normalizeVectorValues(buffer.subarray(0, -1)), /Truncated/);
  assert.throws(() => normalizeVectorValues(Buffer.from([26, 128])), /Truncated/);
});
test('unknown-type QLD point features retain mountain markers without changing their coordinates', async () => {
  const { PbfWriter, PbfReader } = await import('pbf');
  const { VectorTile } = await import('@mapbox/vector-tile');
  const writer = new PbfWriter();
  writer.writeMessage(3, (_, layer) => {
    layer.writeStringField(1, 'Mountain'); layer.writeVarintField(15, 2); layer.writeVarintField(5, 2048);
    for (const [id, geometry, type] of [[1, [9, 1322, 1152], 0], [2, [9, 20, 40], undefined], [3, [9, 20, 40, 10, 4, 6], 0]]) {
      layer.writeMessage(2, (_, f) => {
        f.writeVarintField(1, id);
        if (type !== undefined) f.writeVarintField(3, type);
        f.writePackedVarint(4, geometry);
      });
    }
  });
  const raw = Buffer.from(writer.finish()), repaired = normalizeVectorValues(raw);
  const layer = new VectorTile(new PbfReader(repaired)).layers.Mountain;
  assert.equal(layer.feature(0).type, 1);
  assert.equal(layer.feature(1).type, 1);
  assert.equal(layer.feature(2).type, 0, 'do not guess the type of non-point geometry');
  assert.deepEqual(layer.feature(0).loadGeometry().map(line => line.map(p => [p.x, p.y])), [[[661, 576]]]);
  assert.strictEqual(normalizeVectorValues(repaired), repaired);
});
