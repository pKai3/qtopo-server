const crypto = require('node:crypto');
const path = require('node:path');
const QLD = 'https://spatial.information.qld.gov.au/arcgis/rest/services/Hosted/Basemaps_QldBase_Topographic/VectorTileServer';
const NSW = 'https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile/VectorTileServer';
const NSW_TOPO = 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Topo_Map/MapServer';
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
function createProviders(config) {
  const providers = {
    qld: {
      id: 'qld', name: 'Queensland Topographic', type: 'vector',
      upstream: config.qldUpstream || `${QLD}/tile/{z}/{y}/{x}.pbf`, resourceBase: `${QLD}/resources`,
      stylePath: config.stylePath, seed: 'style.json', minzoom: 2, maxzoom: 19,
      bounds: [137.8, -29.2, 162.7, -9], center: [153.03, -27.47], zoom: 10,
      attribution: '© State of Queensland',
    },
    nsw: {
      id: 'nsw', name: 'NSW Topographic (vector)', type: 'vector',
      upstream: `${NSW}/tile/{z}/{y}/{x}.pbf`, resourceBase: `${NSW}/resources`,
      tileMap: `${NSW}/tilemap?f=json`,
      stylePath: path.join(config.styleDir, 'nsw.style.json'), seed: 'nsw.style.json', minzoom: 3, maxzoom: 22,
      bounds: [140.99, -37.6, 159.3, -28.15], center: [150.31, -33.72], zoom: 11,
      attribution: '© State of New South Wales (Spatial Services)',
    },
    'nsw-topo': {
      id: 'nsw-topo', name: 'NSW Topographic (map sheets)', type: 'raster',
      upstream: `${NSW_TOPO}/tile/{z}/{y}/{x}?blankTile=false`,
      minzoom: 0, maxzoom: 16, tileSize: 256,
      bounds: [140.99, -37.6, 159.3, -28.15], center: [150.31, -33.72], zoom: 12,
      attribution: '© State of New South Wales (Spatial Services)',
    },
  };
  for (const p of Object.values(providers)) {
    if (!/^https?:\/\//.test(p.upstream) || !['{z}', '{x}', '{y}'].every(k => p.upstream.includes(k))) throw new Error(`Invalid tile URL template for ${p.id}`);
    p.cacheId = hash(p.upstream);
  }
  if (!Object.hasOwn(providers, config.defaultProvider)) throw new Error(`Unknown DEFAULT_PROVIDER: ${config.defaultProvider}`);
  return providers;
}
function tileURL(p, z, x, y) { return p.upstream.replaceAll('{z}', z).replaceAll('{x}', x).replaceAll('{y}', y); }
function parseTile(params, maxzoom = 22) {
  if (![params.z, params.x, params.y].every(v => /^\d+$/.test(v))) return null;
  const [z, x, y] = [params.z, params.x, params.y].map(Number);
  if (![z, x, y].every(Number.isSafeInteger) || z > maxzoom || x >= 2 ** z || y >= 2 ** z) return null;
  return { z, x, y };
}
module.exports = { createProviders, tileURL, parseTile, hash };
