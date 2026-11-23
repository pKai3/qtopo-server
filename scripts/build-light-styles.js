#!/usr/bin/env node
// Rebuild the lightweight choices from the maintained detailed styles.
// Keep drawing order, road hierarchy and every terrain/track rule unchanged.
const fs = require('node:fs'), path = require('node:path');
const { formatStyleJson } = require('./style-format');
const directory = path.resolve(__dirname, '../styles');

const qldOmit = new Set([
  'Airport Areas', 'Airport runways and taxiways', 'Cemetery Areas', 'Defence Facility',
  'Infrastructure Area', 'Sports Fields', 'Swimming Pools', 'Building Areas (Geoscape)',
  'Busway', 'Pipelines', 'Powerlines (Energex)', 'Powerlines (Ergon)', 'Powerlines (High Voltage)',
  'Sports Tracks', 'Railway Siding', 'Railway (Under Construction/Proposed)',
  'Railway (Suspended/Dismantled/Abandoned)',
]);
const qldLabels = new Set([
  'Paths', 'QPWS Trails', 'Island Group', 'Island', 'Nature Refuge', 'Beach', 'Bay',
  'Land Subject To Inundation', 'Swamp', 'Valley', 'Region', 'Major Dam Wall', 'Minor Dam Wall',
  'Reefs', 'Health and Medical Facility', 'Recreation Areas', 'Conservation Area',
  'Canal Area', 'Watercourse Areas', 'Lake (Large Scale)', 'Lake (Small Scale)',
  'Cape', 'Ferry Route', 'Ferry Terminals', 'Road Bridge/Overpass',
  'Watercourse (Small Scale)', 'Watercourse (Large Scale)', 'Waterfalls', 'Picnic Area',
  'Lookout', 'Camping Ground', 'Cave', 'Ranges (High Detail)', 'Passage', 'State Forest',
  'National Park', 'Pass', 'Mountain', 'Populated Place', 'Rocks', 'Gate (QPWS)',
  'Emergency Services', 'Police', 'Fire Station', 'Ambulance', 'Railway Stations',
  'Surf Life Saving Club', 'Helipads',
]);
function keepQld(layer) {
  const source = (layer['source-layer'] || '').replace(/\/label.*$/, '').trim();
  if (/Contour/.test(source) || /^Roads \(/.test(source)) return true;
  if (qldOmit.has(source)) return false;
  if (layer.type !== 'symbol') return true;
  if (source === 'Tourism') return layer.id.endsWith('/Tourist Information Centre');
  return qldLabels.has(source);
}

function keepNsw(layer) {
  const source = layer['source-layer'] || '', id = layer.id;
  if (/Contour|Hydro|Watercourse|NPWSReserve|StateForest/.test(source)) return true;
  if (source === 'Suburb/label') return true;
  if (/^(Lot|Property_M|CrownAccountPolygon|Suburb|Runway)(\/|$)/.test(source)) return false;
  if (source === 'GeneralCulturalArea') return !/Building/.test(id);
  if (/^GeneralCulturalLine/.test(source)) return /Dam|Breakwater/.test(id);
  if (/^PointOfInterest/.test(source)) return /Hydrography|Landform|Named ES/.test(id);
  if (source === 'GeneralCulturalPoint') return /CampingGround|Lookout|PicnicArea|Observation|Lighthouse/.test(id);
  if (source === 'BuildingComplexPoint') return /Ambulance|FireStation|PoliceStation|SES_Facility|TouristInformation|GeneralHospital|CaravanPark/.test(id);
  if (/Railway/.test(source) && /Abandoned|Disused|Proposed|Siding/.test(id)) return false;
  return true;
}

for (const [baseId, id, name] of [
  ['readable', 'readable-light', 'Readable Light · desktop'],
  ['mobile-3x', 'mobile-light', 'Hiking Light · mobile 3×'],
]) {
  const doc = JSON.parse(fs.readFileSync(path.join(directory, baseId + '.json')));
  doc.id = id; doc.name = name;
  const counts = {};
  for (const [provider, style] of Object.entries(doc.styles)) {
    const before = style.layers.length;
    style.layers = style.layers.filter(provider === 'qld' ? keepQld : keepNsw);
    style.metadata = { ...style.metadata, 'qtopo:light-source': baseId,
      'qtopo:light-purpose': 'Retain hiking terrain, trails, water, roads and navigation landmarks; omit dense buildings, utilities and minor urban POIs.' };
    counts[provider] = { before, after: style.layers.length };
  }
  fs.writeFileSync(path.join(directory, id + '.json'), formatStyleJson(doc));
  console.log(id + ': ' + JSON.stringify(counts));
}
