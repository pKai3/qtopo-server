#!/usr/bin/env node
// Use the maintained QLD road hierarchy with extra NSW road weight so streets
// stay distinct from parcel boundaries. Trail widths are managed separately.
const fs = require('node:fs'), path = require('node:path');
const { formatStyleJson } = require('../lib/style-format');
const directory = path.resolve(__dirname, '../styles');
const ROAD_WIDTH_FACTOR = 2;
const categories = {
  Motorway: 'Highway/Motorway', PrimaryRoad: 'Highway/Motorway',
  'RTA State Highway': 'Highway/Motorway', 'RTA Motorway': 'Highway/Motorway',
  ArterialRoad: 'Secondary', SubArterialRoad: 'Secondary',
  DistributorRoad: 'Connector', DedicatedBusWay: 'Connector',
  LocalRoad: 'Local', UrbanServiceLane: 'Local',
};
const round = value => Math.round(value * 1e6) / 1e6;
function stops(expression) {
  if (JSON.stringify(expression?.slice(0, 3)) !== '["interpolate",["linear"],["zoom"]]') {
    throw new Error('Expected a linear QLD road width curve');
  }
  const pairs = [];
  for (let i = 3; i < expression.length; i += 2) {
    if (!Number.isFinite(expression[i]) || !Number.isFinite(expression[i + 1])) throw new Error('Non-numeric road width stop');
    pairs.push([expression[i], expression[i + 1]]);
  }
  return pairs;
}
function curve(pairs) { return ['interpolate', ['linear'], ['zoom'], ...pairs.flatMap(([z, width]) => [z, round(width)])]; }
function combine(a, b, fn) {
  const left = stops(a), right = stops(b);
  if (JSON.stringify(left.map(p => p[0])) !== JSON.stringify(right.map(p => p[0]))) throw new Error('Road curve zooms differ');
  return curve(left.map(([z, width], i) => [z, fn(width, right[i][1])]));
}
function roadCurve(qld, category, casing) {
  const suffix = casing ? '/casing' : '';
  const mediumId = `readability/Roads/Roads (Medium Detail)/${category}${suffix}`;
  const medium = qld.layers.find(layer => layer.id === mediumId);
  const highCategory = category === 'Highway/Motorway' ? 'Highway' : category;
  const high = qld.layers.find(layer => layer.type === 'line'
    && layer.id.startsWith(`readability/Roads/Roads (High Detail)/${highCategory},`)
    && !/Tunnel|Bridge/.test(layer.id) && layer.id.endsWith('/casing') === casing);
  if (!medium || !high) throw new Error(`Missing QLD road reference: ${category}${suffix}`);
  const lowStops = stops(medium.paint['line-width']), highStops = stops(high.paint['line-width']);
  const join = lowStops.at(-1), start = highStops[0];
  if (join[0] !== start[0] || Math.abs(join[1] - start[1]) > 1e-6) throw new Error(`Discontinuous QLD road reference: ${category}`);
  return curve([...lowStops, ...highStops.slice(1)].map(([z, width]) => [z, width * ROAD_WIDTH_FACTOR]));
}

function matchNswRoadWidths(nsw, qld) {
  const widths = new Map([...new Set(Object.values(categories))].map(category => [category, {
    surface: roadCurve(qld, category, false), casing: roadCurve(qld, category, true),
  }]));
  let changed = 0;
  for (const layer of nsw.layers) {
    const source = layer['source-layer'] || '';
    if (layer.type !== 'line' || !/^(RoadAgg|RoadSegment|AggregatedWay)/.test(source)) continue;
    const kind = layer.id.split('/')[1]?.replace(/_\d+$/, ''), category = categories[kind];
    if (!category) continue; // Preserve paths, vehicle tracks, access ways and other transport.
    let { surface, casing } = widths.get(category);
    if (kind === 'UrbanServiceLane') {
      surface = curve(stops(surface).map(([z, width]) => [z, width * 0.75]));
      casing = curve(stops(casing).map(([z, width]) => [z, width * 0.75]));
    }
    const part = layer.id.match(/\/(\d+)$/)?.[1], paint = layer.paint;
    const before = JSON.stringify(paint);
    if (source === 'RoadSegment Tunnel' && paint['line-offset'] !== undefined) {
      // Two edge strokes: keep their inside edges flush with the running surface.
      const offset = paint['line-offset'];
      const sign = Math.sign(typeof offset === 'number' ? offset : stops(offset)[0][1]);
      if (!sign) throw new Error(`Expected a signed tunnel edge offset: ${layer.id}`);
      // Repeated runs receive an expression; its first output retains the side.
      paint['line-width'] = combine(casing, surface, (outer, inner) => (outer - inner) / 2);
      paint['line-offset'] = combine(casing, surface, (outer, inner) => sign * (outer + inner) / 4);
    } else if (source === 'RoadSegment Bridge' && part === '2') {
      // Keep the bridge's outer edge beyond its neutral separation stroke.
      paint['line-width'] = combine(casing, surface, (outer, inner) => outer + (outer - inner));
    } else {
      paint['line-width'] = structuredClone(part === undefined || part === '0' ? surface : casing);
    }
    if (JSON.stringify(paint) !== before) changed++;
  }
  return changed;
}

if (require.main === module) {
  for (const id of ['readable', 'mobile-2x', 'mobile-3x']) {
    const file = path.join(directory, id + '.json'), doc = JSON.parse(fs.readFileSync(file));
    console.log(`${id}: ${matchNswRoadWidths(doc.styles.nsw, doc.styles.qld)} NSW road layers resized`);
    fs.writeFileSync(file, formatStyleJson(doc));
  }
  require('./build-light-styles');
}
module.exports = { matchNswRoadWidths };
