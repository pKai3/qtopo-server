const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const layers = id => JSON.parse(fs.readFileSync(path.join(__dirname, '../styles', id + '.json'))).styles.nsw.layers;
const parcels = layers => layers.filter(layer => layer.type === 'fill' && ['Property_M', 'Lot'].includes(layer['source-layer']));

test('detailed NSW styles shade one parcel source above contours and below buildings and roads', () => {
  for (const id of ['readable', 'mobile-2x', 'mobile-3x']) {
    const style = layers(id);
    const [parcel] = parcels(style);
    assert.equal(parcels(style).length, 1);
    assert.equal(parcel['source-layer'], 'Property_M');
    assert.equal(parcel.minzoom, 14);
    const shade = style.indexOf(parcel);
    assert.ok(shade > style.findLastIndex(layer => layer['source-layer'] === 'Contours'));
    assert.ok(shade < style.findIndex(layer => layer.id === 'GeneralCulturalArea/Building'));
    assert.ok(shade < style.findIndex(layer => layer['source-layer'] === 'RoadSegment Tunnel'));
  }
  for (const id of ['readable-light', 'mobile-light']) assert.deepEqual(parcels(layers(id)), []);
});

test('Mobile and Hiking Light keep the NSW gate symbols at a smaller size', () => {
  for (const [id, size] of [['mobile-2x', 1.25], ['mobile-3x', 1.4], ['mobile-light', 1.4]]) {
    const style = layers(id);
    for (const suffix of ['', '_1']) {
      const gate = style.find(layer => layer.id === 'TrafficControlDevice/Gate' + suffix);
      assert.equal(gate.layout['icon-image'], 'TrafficControlDevice/Gate' + suffix);
      assert.equal(gate.layout['icon-size'], size);
    }
  }
});
