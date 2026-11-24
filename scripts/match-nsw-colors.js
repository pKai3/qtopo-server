#!/usr/bin/env node
// Match NSW's existing feature classes to the corresponding QLD style palette.
// This only edits paint colors and constant overlay opacity, never tile sources,
// feature filters, geometry, drawing order, zooms, line widths or label placement.
const fs = require('node:fs'), path = require('node:path');
const { formatStyleJson } = require('../lib/style-format');
const directory = path.resolve(__dirname, '../styles');

function matchNswColors(nsw, qld) {
  // The untouched source style distinguishes white bridge/track knockouts from
  // colored casings. Never infer those roles from a palette already recolored.
  const original = new Map(JSON.parse(fs.readFileSync(path.join(directory, 'nsw.style.json'))).layers.map(layer => [layer.id, layer.paint || {}]));
  const q = (source, type, property, id) => qld.layers.find(layer =>
    layer.type === type && (layer['source-layer'] || '').trim() === source &&
    (!id || id.test(layer.id)) && layer.paint?.[property] !== undefined)?.paint[property];
  const fill = (source, property = 'fill-color') => q(source, 'fill', property);
  const line = (source, id, property = 'line-color') => q(source, 'line', property, id);
  const label = source => q(source, 'symbol', 'text-color');
  const icon = source => q(source, 'symbol', 'icon-color');
  const detailed = qld.layers.some(layer => layer.id.startsWith('readability/'));
  const road = (category, casing = false) => detailed
    ? line('Roads (Medium Detail)', new RegExp('/' + category + (casing ? '/casing$' : '$')))
    : line('Roads (High Detail)');
  const contour = (major, property) => line('Contour (Medium Scale)',
    detailed ? new RegExp('/' + (major ? 'Index' : 'Intermediate') + ' Contour$') : undefined, property);
  const halo = q('Populated Place', 'symbol', 'text-halo-color') || '#ffffff';
  const contourInk = label('Contour (Medium Scale)/label');
  const contourHalo = q('Contour (Medium Scale)/label', 'symbol', 'text-halo-color') || halo;
  let changed = 0;
  for (const layer of nsw.layers) {
    const previous = JSON.stringify(layer.paint), source = layer['source-layer'] || '', id = layer.id;
    const paint = layer.paint ||= {};
    const set = (property, value) => { if (value !== undefined) paint[property] = structuredClone(value); };
    const copyFill = target => {
      set('fill-color', fill(target));
      // Zoom-dependent fading belongs to the feature's existing scale behavior.
      // Only match constant opacities, which determine the apparent overlay tint.
      const opacity = fill(target, 'fill-opacity');
      if (typeof opacity === 'number' && (paint['fill-opacity'] === undefined || typeof paint['fill-opacity'] === 'number')) set('fill-opacity', opacity);
    };
    if (layer.type === 'background') set('background-color', fill('Mainland'));
    if (layer.type === 'fill' && !paint['fill-pattern']) {
      if (source === 'NPWSReserve') copyFill(/\/NationalPark$/.test(id) ? 'National Park' : /\/NatureReserve$/.test(id) ? 'Nature Refuge' : 'Conservation Area');
      else if (source === 'StateForest') copyFill('State Forest');
      else if (source === 'GeneralCulturalArea') copyFill(id.endsWith('/Building') ? 'Building Areas (Geoscape)' : 'Urban Area');
      else if (/^HydroArea/.test(source)) copyFill(id.includes('/Watercourse/') ? 'Watercourse Areas' : 'Lake (Large Scale)');
      else if (source === 'FuzzyExtentWaterArea') copyFill(id.endsWith('/SeaLike') || id.endsWith('/BayLike') ? 'Seas' : 'Watercourse Areas');
    }
    if (layer.type === 'line') {
      if (source === 'Contours') {
        set('line-color', contour(id.endsWith(', Major'), 'line-color'));
        const opacity = contour(id.endsWith(', Major'), 'line-opacity');
        if (typeof opacity === 'number') set('line-opacity', opacity);
      } else if (source === 'HydroLine' || source === 'NamedWatercourse') set('line-color', line('Watercourse (Large Scale)'));
      else if (/^HydroArea/.test(source)) set('line-color', line('Shoreline'));
      else if (source === 'Border') set('line-color', line('State Border'));
      else if (source.startsWith('Railway')) {
        // White bridge knockouts separate the crossing from the underlying map.
        if (!/\/2$/.test(id)) set('line-color', line(/Disused|Dismantled/.test(id) ? 'Railway (Suspended/Dismantled/Abandoned)' : /UnderConstruction/.test(id) ? 'Railway (Under Construction/Proposed)' : 'Railway (Operational)'));
      } else if (/^(RoadAgg|RoadSegment|AggregatedWay)/.test(source) && !/UnderConstruction/.test(source)) {
        const kind = id.split('/')[1]?.replace(/_\d+$/, ''), part = id.match(/\/(\d+)$/)?.[1];
        const bridge = source.endsWith(' Bridge');
        const white = /^#(?:fff|ffffff|fafafa|e1e1e1)$/i.test(original.get(id)?.['line-color']);
        let color;
        if (kind === 'Path') color = bridge && part === '1' ? road('Local') : line('Paths');
        else if (kind === 'Track-Vehicular') color = white ? road('Local') : road('Vehicular Track');
        else if (kind === 'AccessWay') color = white ? road('Local') : road('Restricted');
        else if (kind === 'DedicatedBusWay') color = part === '0' ? line('Busway') : white ? road('Local') : road('Local', true);
        else {
          const category = /Motorway|Highway/.test(kind) ? 'Highway/Motorway' : kind === 'PrimaryRoad' ? 'Highway/Motorway' : /ArterialRoad/.test(kind) ? 'Secondary' : kind === 'DistributorRoad' ? 'Connector' : 'Local';
          // /0 is the running surface; other strokes outline it or mark a bridge.
          // At small scales there is a single line, so retain the road's surface hue.
          color = part === undefined || part === '0' ? road(category) : bridge && white ? road('Local') : road(category, true);
        }
        set('line-color', color);
      } else if (source === 'GeneralCulturalLine') {
        set('line-color', line(/DamWall/.test(id) ? 'Major Dam Wall' : /Breakwater/.test(id) ? 'Marine Structures' : 'Sports Tracks'));
      } else if (source === 'Runway') set('line-color', fill('Airport runways and taxiways'));
      else if (source === 'TransportFacilityLine') set('line-color', line('Marine Structures'));
    }
    if (layer.type === 'symbol') {
      // Preserve the original NSW glyphs and sprites, including white/transparent
      // icon components. Label ink can match without changing their semantics.
      if (paint['text-halo-color'] !== undefined) set('text-halo-color', halo);
      if (layer.layout?.['text-field'] !== undefined) {
        let color;
        if (source === 'Contours/label') { color = contourInk; set('text-halo-color', contourHalo); }
        else if (source === 'NPWSReserve/label') color = label('National Park/label');
        else if (source === 'StateForest/label') color = label('State Forest/label') || label('National Park/label');
        else if (/^NamedWatercourse/.test(source)) color = label('Watercourse (Large Scale)/label');
        else if (/^HydroArea/.test(source)) color = label('Lake (Large Scale)/label');
        else if (source === 'FuzzyExtentWaterArea/label') color = /RiverLike/.test(id) ? label('Watercourse Areas/label') : /BayLike/.test(id) ? label('Bay/label') : label('Passage/label');
        else if (/^(RoadAgg|RoadSegment)/.test(source)) color = detailed
          ? q('Roads (High Detail)/label', 'symbol', 'text-color', /Urban|Local/.test(id) ? /\/Local$/ : /\/Secondary$/)
          : label('Roads (High Detail)/label');
        else if (/^Railway/.test(source)) color = label('Railway (Operational)/label');
        else if (/^PlacePoint/.test(source) || source === 'Suburb/label') color = label('Populated Place');
        else if (source === 'FuzzyExtentLine/label') color = label(/RangeLike/.test(id) ? 'Ranges (High Detail)/label' : /ValleyLike/.test(id) ? 'Valley/label' : /Beach/.test(id) ? 'Beach/label' : 'Region/label');
        else if (source === 'FuzzyExtentPoint') {
          const mountain = label('Mountain'), current = paint['text-color'];
          const condition = ['==', ['get', '_symbol'], 6];
          const other = current?.[0] === 'case' && JSON.stringify(current[1]) === JSON.stringify(condition) ? current[3] : current;
          if (mountain !== undefined) color = ['case', condition, mountain, other];
        } else if (source === 'SpotHeight' || source === 'RelativeHeight') color = contourInk;
        else if (source === 'AncillaryHydroPoint') color = /Waterfall/.test(id) ? label('Waterfalls') : label('Watercourse Areas/label');
        else if (source === 'GeneralCulturalLine/label') color = label('Major Dam Wall/label');
        else if (source === 'BuildingComplexPoint' && /Homestead/.test(id)) color = label('Homesteads');
        else if (source === 'TrafficControlDevice') color = label('Gate (QPWS)');
        else if (source === 'Crossing') color = label('Road Bridge/Overpass/label');
        set('text-color', color);
      }
      if (source === 'FuzzyExtentPoint' && id.endsWith('/MountainLike')) set('icon-color', icon('Mountain') || q('Mountain', 'circle', 'circle-color'));
      if (source.startsWith('Railway') && paint['icon-color']) set('icon-color', line(/Disused|Dismantled/.test(id) ? 'Railway (Suspended/Dismantled/Abandoned)' : /UnderConstruction/.test(id) ? 'Railway (Under Construction/Proposed)' : 'Railway (Operational)'));
    }
    if (!Object.keys(paint).length) delete layer.paint;
    if (JSON.stringify(layer.paint) !== previous) changed++;
  }
  return changed;
}

if (require.main === module) {
  for (const id of ['readable', 'mobile-2x', 'mobile-3x']) {
    const file = path.join(directory, id + '.json'), doc = JSON.parse(fs.readFileSync(file));
    console.log(`${id}: ${matchNswColors(doc.styles.nsw, doc.styles.qld)} NSW layers recolored`);
    fs.writeFileSync(file, formatStyleJson(doc));
  }
  require('./build-light-styles');
}

module.exports = { matchNswColors };
