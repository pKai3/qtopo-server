const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('./providers');
const { getProfile, applyProfile, NSW_CONTOUR_SOURCE, assertProviderSources } = require('./profiles');
const { httpError } = require('./utils');
async function seedStyles(config, providers) {
  for (const p of Object.values(providers).filter(p => p.stylePath)) {
    await fs.mkdir(path.dirname(p.stylePath), { recursive: true });
    try { await fs.copyFile(path.join(config.root, 'styles', p.seed), p.stylePath, require('node:fs').constants.COPYFILE_EXCL); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    const style = JSON.parse(await fs.readFile(p.stylePath, 'utf8'));
    if (style.version !== 8 || !Array.isArray(style.layers)) throw new Error(`Invalid style: ${p.stylePath}`);
  }
}
// Keep camera expressions at the top level, as required by the style specification.
function scaleValue(value, factor) {
  if (typeof value === 'number') return value * factor;
  if (Array.isArray(value)) {
    const out = structuredClone(value);
    if (out[0] === 'interpolate' || out[0] === 'interpolate-hcl' || out[0] === 'interpolate-lab') {
      for (let i = 4; i < out.length; i += 2) out[i] = scaleValue(out[i], factor);
      return out;
    }
    if (out[0] === 'step') {
      out[2] = scaleValue(out[2], factor);
      for (let i = 4; i < out.length; i += 2) out[i] = scaleValue(out[i], factor);
      return out;
    }
    return ['*', factor, out];
  }
  if (value && typeof value === 'object' && value.stops) return { ...value, stops: value.stops.map(([input, output]) => [input, scaleValue(output, factor)]) };
  return value;
}
async function getStyle(config, provider, override) {
  if (provider.type === 'raster') return {
    version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: { [provider.id]: {
      type: 'raster', tiles: [`/raster/${provider.id}/{z}/{x}/{y}.png`], tileSize: 256,
      bounds: provider.bounds, minzoom: provider.minzoom, maxzoom: provider.maxzoom, attribution: provider.attribution,
    } }, layers: [{ id: 'topographic-map', type: 'raster', source: provider.id }],
  };
  const style = override ? structuredClone(override) : JSON.parse(await fs.readFile(provider.stylePath, 'utf8'));
  assertProviderSources(style);
  // These are the original provider sources. Generated contour sources are
  // added afterwards, so imported URLs never become an unrestricted proxy.
  for (const source of Object.values(style.sources || {})) {
    if (source.type !== 'vector') continue;
    delete source.url;
    Object.assign(source, { tiles: [`/vector/${provider.id}/{z}/{x}/{y}.pbf`], attribution: provider.attribution });
    source.maxzoom = Math.min(source.maxzoom ?? provider.maxzoom, provider.maxzoom);
    source.bounds = source.bounds || provider.bounds;
  }
  if (provider.id === 'nsw') {
    style.glyphs = '/resources/nsw/fonts/{fontstack}/{range}.pbf';
    style.sprite = '/resources/nsw/sprites/sprite';
    // The published style is an overlay with no background. Supply the same
    // light base for the browser and standalone GPS PNGs, while honoring edits.
    if (!style.layers.some(layer => layer.type === 'background')) {
      style.layers.unshift({ id: 'qtopo-background', type: 'background', paint: { 'background-color': '#f8f7ef' } });
    }
  } else {
    const official = override && style.sprite === '/resources/qld/sprites/sprite';
    style.glyphs = official ? '/resources/qld/fonts/{fontstack}/{range}.pbf' : override ? '/fonts/{fontstack}/{range}.pbf' : style.glyphs || '/fonts/{fontstack}/{range}.pbf';
    style.sprite = official ? '/resources/qld/sprites/sprite' : override ? '/assets/sprites/qld' : style.sprite || '/assets/sprites/qld';
  }
  return style;
}
function contourSource(dataset) {
  if (!dataset || typeof dataset.revision !== 'string' || !/^[a-f0-9]{64}$/.test(dataset.revision)) throw httpError('NSW 2 m contours are not ready', 503);
  const tiles = `/contours/nsw/${dataset.revision}/{z}/{x}/{y}.pbf`;
  const bounds = dataset.bounds;
  if (dataset.tiles !== tiles || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
      || bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -85.051129 || bounds[3] > 85.051129
      || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]
      || !Number.isInteger(dataset.minzoom) || !Number.isInteger(dataset.maxzoom)
      || dataset.minzoom < 0 || dataset.maxzoom > 22 || dataset.minzoom > dataset.maxzoom
      || typeof dataset.attribution !== 'string' || !dataset.attribution.trim() || dataset.attribution.length > 4096) {
    throw httpError('Invalid prepared NSW 2 m contour dataset', 503);
  }
  return { type: 'vector', tiles: [tiles], bounds: [...bounds], minzoom: dataset.minzoom,
    maxzoom: dataset.maxzoom, attribution: dataset.attribution };
}
function addNSWContours(style, source) {
  const copy = structuredClone(style);
  copy.sources[NSW_CONTOUR_SOURCE] = source;
  // The importer stores a numeric elevation in metres. A nonnumeric/missing
  // value cannot accidentally become a zero-metre contour.
  const elevation = ['number', ['get', 'elevation'], -1];
  const multiple = interval => ['==', ['%', elevation, interval], 0];
  const filters = [multiple(50), ['all', multiple(10), ['!', multiple(50)]], ['all', multiple(2), ['!', multiple(10)]]];
  const lines = [50, 10, 2].map((interval, i) => ({
    id: `${NSW_CONTOUR_SOURCE}-${interval}m`, type: 'line', source: NSW_CONTOUR_SOURCE, 'source-layer': 'contours',
    minzoom: [10, 12, 15][i], filter: filters[i], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ac846b', 'line-width': [1.2, 0.8, 0.5][i], 'line-opacity': 0.78 },
  }));
  const labels = [50, 10].map((interval, i) => ({
    id: `${NSW_CONTOUR_SOURCE}-${interval}m-label`, type: 'symbol', source: NSW_CONTOUR_SOURCE, 'source-layer': 'contours',
    minzoom: [12, 16][i], filter: filters[i],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 1000, 'text-font': ['Public Sans Bold'],
      'text-size': 9.33333, 'text-field': ['to-string', ['get', 'elevation']], 'text-optional': true },
    paint: { 'text-color': '#88654f', 'text-halo-color': '#ffffff', 'text-halo-width': 1.33333 },
  }));
  let addedLines = false, addedLabels = false;
  copy.layers = copy.layers.flatMap(layer => {
    if (layer['source-layer'] === 'Contours') {
      if (addedLines) return [];
      addedLines = true; return lines;
    }
    if (layer['source-layer'] === 'Contours/label') {
      if (addedLabels) return [];
      addedLabels = true; return labels;
    }
    return [layer];
  });
  // Custom base styles may have removed their original contours already.
  if (!addedLines) {
    const firstLabel = copy.layers.findIndex(layer => layer.type === 'symbol');
    copy.layers.splice(firstLabel < 0 ? copy.layers.length : firstLabel, 0, ...lines);
  }
  if (!addedLabels) copy.layers.push(...labels);
  return copy;
}
function absoluteStyle(style, origin) {
  const result = structuredClone(style);
  const absolute = url => /^https?:\/\//i.test(url) ? url : origin + (url.startsWith('/') ? url : '/' + url);
  if (result.glyphs) result.glyphs = absolute(result.glyphs);
  if (typeof result.sprite === 'string') result.sprite = absolute(result.sprite);
  if (Array.isArray(result.sprite)) result.sprite = result.sprite.map(s => ({ ...s, url: absolute(s.url) }));
  for (const source of Object.values(result.sources || {})) {
    if (source.tiles) source.tiles = source.tiles.map(absolute);
    if (source.url) source.url = absolute(source.url);
    if (typeof source.data === 'string') source.data = absolute(source.data);
  }
  return result;
}
function renderStyle(style, labelScale, transparentBackground = true) {
  const copy = structuredClone(style);
  for (const l of copy.layers) {
    if (transparentBackground && l.type === 'background') l.paint = { ...l.paint, 'background-opacity': 0 };
    if (labelScale !== 1 && l.layout) {
      for (const k of ['text-size', 'icon-size']) if (k in l.layout) l.layout[k] = scaleValue(l.layout[k], labelScale);
    }
  }
  return copy;
}
function styleRevision(style, config, provider) {
  return hash(JSON.stringify({ version: 2, style, pixels: config.tilePx, scale: config.labelScale, upstream: provider.cacheId,
    ...(provider.type === 'vector' ? { renderVersion: 3, metatileSize: config.metatileSize, buffer: config.renderBufferPx } : {}),
  }));
}
function createStyleCache(config) {
  const entries = new Map();
  let loads = 0, hits = 0;
  return {
    async get(provider, profileId = 'classic') {
      const profile = typeof profileId === 'string' ? getProfile(profileId) : profileId;
      if (!profile) throw new Error(`Unknown profile: ${profileId}`);
      const contours = provider.id === 'nsw' && profile.id === 'nsw-2m' ? contourSource(profile.contourDataset) : null;
      const key = `${provider.id}/${profile.id}`;
      // Check file metadata on every access so edits take effect immediately.
      const stat = !profile.styles && provider.stylePath ? await fs.stat(provider.stylePath) : null;
      const stamp = (profile.token || '') + (stat ? `${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}` : '')
        + (contours ? JSON.stringify(contours) : '');
      const previous = entries.get(key);
      if (previous?.stamp === stamp) { hits++; return previous.promise; }
      const entry = { stamp };
      entry.promise = getStyle(config, provider, profile.styles?.[provider.id]).then(style => {
        loads++;
        if (!profile.styles) style = applyProfile(style, provider, profile, scaleValue);
        const providerSources = Object.keys(style.sources).filter(id => style.sources[id].type === 'vector');
        if (contours) style = addNSWContours(style, contours);
        const prepare = value => {
          const revision = styleRevision(value, config, provider);
          return { style: value, revision: profile.id === 'classic' || provider.type === 'raster' ? revision
            : hash(JSON.stringify({ revision, profile: profile.id, recipe: profile.revision })) };
        };
        const base = prepare(style), variants = new Map();
        return { ...base, atZoom(zoom) {
          if (!variants.has(zoom)) {
            let variant = structuredClone(style);
            for (const id of providerSources) {
              if (zoom === null) delete variant.sources[id];
              else variant.sources[id].maxzoom = Math.min(variant.sources[id].maxzoom, zoom);
            }
            if (zoom === null) {
              variant.layers = variant.layers.filter(layer => !providerSources.includes(layer.source));
              if (!contours || !Object.keys(variant.sources).length) variant = { version: 8, sources: {}, layers: [] };
            }
            variants.set(zoom, prepare(variant));
          }
          return variants.get(zoom);
        } };
      }).catch(err => { if (entries.get(key) === entry) entries.delete(key); throw err; });
      entries.set(key, entry);
      return entry.promise;
    },
    get stats() { return { loads, hits, providers: entries.size }; },
  };
}
module.exports = { seedStyles, getStyle, absoluteStyle, renderStyle, styleRevision, scaleValue, createStyleCache };
