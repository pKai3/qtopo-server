#!/usr/bin/env node
// Town/locality names orient an overview; at street level leave room for roads
// and landmarks. Historic sites share NSW's PlacePoint source, so keep them.
const fs = require('node:fs'), path = require('node:path');
const { formatStyleJson } = require('../lib/style-format');
const directory = path.resolve(__dirname, '../styles');
for (const id of ['readable', 'mobile-2x', 'mobile-3x']) {
  const file = path.join(directory, id + '.json'), doc = JSON.parse(fs.readFileSync(file));
  let changed = 0;
  for (const [state, style] of Object.entries(doc.styles)) for (const layer of style.layers) {
    const source = layer['source-layer'] || '';
    const place = state === 'qld'
      ? source === 'Populated Place' && layer.type === 'symbol' && layer.layout?.['text-field'] !== undefined
      : source === 'Suburb/label' || layer.id === 'FuzzyExtentLine/label/GeneralLocality'
        || source.startsWith('PlacePoint') && /\/(?:label\/)?(?:Major |Medium |Capital |Cap)?(?:City|Town|MajorTown|Village|Locality|Suburb|CapCity)(?: |_|$)/.test(layer.id);
    if (place && (layer.maxzoom ?? 24) > 15) { layer.maxzoom = 15; changed++; }
  }
  fs.writeFileSync(file, formatStyleJson(doc));
  console.log(`${id}: ${changed} place labels/markers limited to overview zooms`);
}
require('./build-light-styles');
