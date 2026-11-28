const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { expression, latest, validateStyleMin } = require('@maplibre/maplibre-gl-style-spec');
const { matchNswRoadWidths } = require('../scripts/match-nsw-road-widths');
const read = id => JSON.parse(fs.readFileSync(path.join(__dirname, '../styles', id + '.json')));
const compiled = new Map();
function value(layer, key, zoom) {
  const input = layer.paint[key] ?? 0;
  if (typeof input === 'number') return input;
  const cacheKey = JSON.stringify([key, input]);
  if (!compiled.has(cacheKey)) {
    const result = expression.createPropertyExpression(input, key, latest.paint_line[key]);
    assert.equal(result.result, 'success', JSON.stringify(result));
    compiled.set(cacheKey, result.value);
  }
  return compiled.get(cacheKey).evaluate({ zoom });
}
const active = (layers, zoom) => layers.filter(l => zoom >= (l.minzoom ?? 0) && zoom < (l.maxzoom ?? 24));
function extent(layers, zoom) {
  return Math.max(...active(layers, zoom).map(l => value(l, 'line-width', zoom) + 2 * Math.abs(value(l, 'line-offset', zoom))));
}
const ordinary = (style, kind) => style.layers.filter(l => l.type === 'line' && l['source-layer'] === 'RoadAgg_M'
  && new RegExp(`^RoadAgg_M/${kind}(?:_\\d+)?/`).test(l.id));

test('maintained roads keep moderate widths, hierarchy and continuous NSW zoom switches', () => {
  for (const id of ['readable', 'mobile-2x', 'mobile-3x', 'readable-light', 'mobile-light']) {
    const style = read(id).styles.nsw;
    assert.deepEqual(validateStyleMin(style), [], id);
    for (const kind of ['LocalRoad', 'DistributorRoad', 'SubArterialRoad', 'ArterialRoad', 'PrimaryRoad', 'Motorway']) {
      const layers = ordinary(style, kind);
      for (const z of [13, 14, 16]) {
        assert.ok(Math.abs(extent(layers, z - 1e-5) - extent(layers, z)) < 0.001, `${id}/${kind}: jump at z${z}`);
      }
      for (const z of [14, 15, 16, 17, 18, 22]) assert.ok(extent(layers, z) < 24, `${id}/${kind}: excessive width at z${z}`);
    }
    for (const z of [14, 15, 16, 17, 18, 22]) {
      const widths = ['LocalRoad', 'DistributorRoad', 'ArterialRoad', 'PrimaryRoad'].map(kind => extent(ordinary(style, kind), z));
      assert.ok(widths.every((width, i) => !i || width > widths[i - 1]), `${id}: lost road hierarchy at z${z}`);
    }
  }
  const mobile = read('mobile-3x').styles.nsw;
  assert.ok(Math.abs(extent(ordinary(mobile, 'LocalRoad'), 16) - 8.8) < 0.02);
  assert.ok(Math.abs(extent(ordinary(mobile, 'PrimaryRoad'), 16) - 14.7) < 0.1);
});

test('bridge surfaces and tunnel edges meet their adjoining roads', () => {
  for (const id of ['readable', 'mobile-2x', 'mobile-3x']) {
    const style = read(id).styles.nsw;
    for (const kind of ['LocalRoad', 'DistributorRoad', 'SubArterialRoad', 'ArterialRoad', 'PrimaryRoad', 'Motorway']) {
      const layer = (source, part) => style.layers.find(l => l.id === `${source}/${kind}/${part}`);
      for (const z of [16, 17, 18, 22]) {
        const roadSurface = value(layer('RoadAgg_M', '0'), 'line-width', z);
        const roadOuter = value(layer('RoadAgg_M', '1'), 'line-width', z);
        for (const source of ['RoadSegment Bridge', 'RoadSegment Tunnel']) {
          assert.equal(value(layer(source, '0'), 'line-width', z), roadSurface);
        }
        const bridgeInner = value(layer('RoadSegment Bridge', '1'), 'line-width', z);
        const bridgeOuter = value(layer('RoadSegment Bridge', '2'), 'line-width', z);
        assert.ok(bridgeOuter > bridgeInner && bridgeInner > roadSurface);
        const edges = [layer('RoadSegment Tunnel', '1'), layer('RoadSegment Tunnel', '2')];
        assert.ok(value(edges[0], 'line-offset', z) * value(edges[1], 'line-offset', z) < 0);
        for (const edge of edges) {
          const width = value(edge, 'line-width', z), offset = Math.abs(value(edge, 'line-offset', z));
          assert.ok(Math.abs(offset - width / 2 - roadSurface / 2) < 1e-5, 'tunnel edge floats away from surface');
          assert.ok(Math.abs(offset + width / 2 - roadOuter / 2) < 1e-5, 'tunnel edge bulges beyond road');
        }
      }
    }
  }
});

test('rebuilding widths is idempotent and only changes paved road dimensions', () => {
  for (const id of ['readable', 'mobile-2x', 'mobile-3x']) {
    const doc = read(id), original = read('nsw.style');
    const before = structuredClone(original);
    assert.ok(matchNswRoadWidths(original, doc.styles.qld) > 0);
    for (let i = 0; i < original.layers.length; i++) {
      const after = structuredClone(original.layers[i]), prior = before.layers[i];
      for (const key of ['line-width', 'line-offset']) {
        if (prior.paint && key in prior.paint) after.paint[key] = prior.paint[key];
      }
      assert.deepEqual(after, prior, `non-dimension change in ${prior.id}`);
      if (!/^(RoadAgg|RoadSegment|AggregatedWay)/.test(prior['source-layer'] || '') || /Path|Track-Vehicular|AccessWay|UnderConstruction/.test(prior.id)) {
        assert.deepEqual(original.layers[i], prior, `unrelated feature changed: ${prior.id}`);
      }
    }
    assert.equal(matchNswRoadWidths(original, doc.styles.qld), 0);
    assert.equal(matchNswRoadWidths(doc.styles.nsw, doc.styles.qld), 0, 'committed widths are stale');
  }
  for (const [full, light] of [['readable', 'readable-light'], ['mobile-3x', 'mobile-light']]) {
    const detailed = new Map(read(full).styles.nsw.layers.map(l => [l.id, l]));
    for (const layer of read(light).styles.nsw.layers) assert.deepEqual(layer, detailed.get(layer.id));
  }
});

test('trail widths retain the earlier NSW sizing and are not changed by the road recipe', () => {
  const original = new Map(read('nsw.style').layers.map(layer => [layer.id, layer]));
  for (const [id, factor] of [['readable', 1], ['mobile-2x', 2], ['mobile-3x', 3], ['readable-light', 1], ['mobile-light', 3]]) {
    const doc = read(id), style = doc.styles.nsw;
    const trails = style.layers.filter(layer => layer.type === 'line' && /^(RoadAgg|RoadSegment)/.test(layer['source-layer'] || '')
      && /\/(?:Path|Track-Vehicular|AccessWay)(?:_|\/|$)/.test(layer.id));
    assert.ok(trails.length > 0);
    const before = structuredClone(trails);
    for (const trail of trails) {
      const reference = original.get(trail.id);
      assert.equal(trail.paint['line-width'], reference.paint['line-width'] * factor, `${id}/${trail.id}: earlier trail width lost`);
      assert.deepEqual(trail.paint['line-dasharray'], reference.paint['line-dasharray']);
    }
    matchNswRoadWidths(style, doc.styles.qld);
    assert.deepEqual(trails, before, `${id}: paved-road adjustment changed trails`);
  }
});
