const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('./providers');
const { getProfile, applyProfile } = require('./profiles');
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
async function getStyle(config, provider) {
  if (provider.type === 'raster') return {
    version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: { [provider.id]: {
      type: 'raster', tiles: [`/raster/${provider.id}/{z}/{x}/{y}.png`], tileSize: 256,
      bounds: provider.bounds, minzoom: provider.minzoom, maxzoom: provider.maxzoom, attribution: provider.attribution,
    } }, layers: [{ id: 'topographic-map', type: 'raster', source: provider.id }],
  };
  const style = JSON.parse(await fs.readFile(provider.stylePath, 'utf8'));
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
    style.glyphs = style.glyphs || '/fonts/{fontstack}/{range}.pbf';
    style.sprite = style.sprite || '/assets/sprites/qld';
  }
  return style;
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
      const profile = getProfile(profileId);
      if (!profile) throw new Error(`Unknown profile: ${profileId}`);
      const key = `${provider.id}/${profile.id}`;
      // Check file metadata on every access so edits take effect immediately.
      const stat = provider.stylePath ? await fs.stat(provider.stylePath) : null;
      const stamp = stat ? `${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}` : '';
      const previous = entries.get(key);
      if (previous?.stamp === stamp) { hits++; return previous.promise; }
      const entry = { stamp };
      entry.promise = getStyle(config, provider).then(style => {
        loads++;
        style = applyProfile(style, provider, profile, scaleValue);
        const prepare = value => {
          const revision = styleRevision(value, config, provider);
          return { style: value, revision: profile.id === 'classic' || provider.type === 'raster' ? revision
            : hash(JSON.stringify({ revision, profile: profile.id, recipe: profile.revision })) };
        };
        const base = prepare(style), variants = new Map();
        return { ...base, atZoom(zoom) {
          if (!variants.has(zoom)) {
            const variant = zoom === null ? { version: 8, sources: {}, layers: [] } : structuredClone(style);
            for (const source of Object.values(variant.sources)) {
              if (source.type === 'vector') source.maxzoom = Math.min(source.maxzoom, zoom);
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
