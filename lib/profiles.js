// Public names follow the current recipe. Bump revision when a recipe changes;
// rendered cache revisions change without renaming URLs or touching raw data.
const profiles = Object.freeze([
  { id: 'classic', name: 'Classic', factor: 1, refined: false, revision: 1 },
  { id: 'readable', name: 'Readable · desktop size', factor: 1, refined: true, revision: 2 },
  { id: 'size-2x', name: 'Original colours · 2×', factor: 2, refined: false, revision: 1 },
  { id: 'size-3x', name: 'Original colours · 3×', factor: 3, refined: false, revision: 1 },
  { id: 'mobile-2x', name: 'Mobile · 2×', factor: 2, refined: true, revision: 2 },
  { id: 'mobile-3x', name: 'Mobile', factor: 3, refined: true, revision: 2 },
].map(Object.freeze));
const getProfile = id => profiles.find(p => p.id === id);
const waterIds = new Set(['canal-area', 'pondage-areas', 'lake-large', 'lake-small', 'watercourse-areas']);
const streamIds = new Set(['watercourses-large', 'watercourses-small']);

function applyProfile(style, provider, profile, scaleValue) {
  if (profile.id === 'classic' || provider.type === 'raster') return style;
  const copy = structuredClone(style), factor = profile.factor;
  if (factor !== 1) for (const layer of copy.layers) {
    const layout = layer.layout, paint = layer.paint;
    if (layout && 'text-field' in layout) {
      layout['text-size'] = scaleValue(layout['text-size'] ?? 16, factor);
      layout['text-padding'] = scaleValue(layout['text-padding'] ?? 2, factor);
    }
    if (layout && 'icon-image' in layout) {
      layout['icon-size'] = scaleValue(layout['icon-size'] ?? 1, factor);
      layout['icon-padding'] = scaleValue(layout['icon-padding'] ?? 2, factor);
    }
    if (layout?.['symbol-placement'] === 'line') layout['symbol-spacing'] = scaleValue(layout['symbol-spacing'] ?? 250, factor);
    for (const key of ['line-width', 'line-gap-width', 'line-offset', 'line-blur', 'circle-radius', 'circle-stroke-width', 'text-halo-width', 'text-halo-blur', 'icon-halo-width', 'icon-halo-blur']) {
      if (paint && key in paint) paint[key] = scaleValue(paint[key], factor);
    }
    // Text offsets are in em, dash arrays in line widths, and icon offsets
    // already scale with icon-size. Multiplying them again compounds sizing.
  }
  if (!profile.refined) return copy;
  if (provider.id === 'qld') {
    // Mask only permanent water interiors. Retain creek segments outside the
    // polygons, and keep shoreline/bridge/ferry/road strokes above the mask.
    const streams = copy.layers.filter(l => streamIds.has(l.id));
    const water = copy.layers.filter(l => waterIds.has(l.id));
    const rest = copy.layers.filter(l => !streamIds.has(l.id) && !waterIds.has(l.id));
    let after = 0;
    rest.forEach((l, i) => { if (l.type === 'fill') after = i + 1; });
    rest.splice(after, 0, ...streams, ...water);
    copy.layers = rest;
  }
  for (const layer of copy.layers) {
    const id = layer.id, p = layer.paint ||= {}, layout = layer.layout;
    const qld = provider.id === 'qld';
    if (layer.type === 'fill') {
      if (qld ? waterIds.has(id) : /^(HydroArea|FuzzyExtentWaterArea)/.test(id)) {
        p['fill-color'] = '#c5e2ee'; p['fill-opacity'] = 1;
      }
      if (id === 'building-areas-geoscape' || id === 'GeneralCulturalArea/Building') {
        p['fill-color'] = '#9da8ad'; p['fill-opacity'] = 0.5;
      }
      if (id === 'vegetation') { p['fill-color'] = '#79aa72'; p['fill-opacity'] = 0.35; }
      if (/^(national-park|nature-refuge|conservation-area)$/.test(id)) { p['fill-color'] = '#91bc83'; p['fill-opacity'] = 0.28; }
      if (/^(state-forest|forest-plantation|rainforest|mangrove)$/.test(id)) { p['fill-color'] = '#668f66'; p['fill-opacity'] = 0.3; }
      if (id === 'sports-fields') { p['fill-color'] = '#b1d1a0'; p['fill-opacity'] = 0.65; }
    }
    if (layer.type === 'line') {
      if (/^powerlines-/.test(id)) {
        Object.assign(p, { 'line-color': '#858a8b', 'line-width': 1, 'line-opacity': 0.75, 'line-dasharray': [4, 3] });
      } else if (/contour/i.test(id)) {
        p['line-color'] = '#ac846b'; p['line-opacity'] = 0.78;
        // Desktop retains its original stroke dimensions.
        if (factor > 1) p['line-width'] = scaleValue(p['line-width'] ?? factor, 0.68);
      } else if (/^roads-|^road-bridge/.test(id)) p['line-color'] = '#697479';
      else if (streamIds.has(id) || /shoreline|coastline|^HydroLine\/|^NamedWatercourse$|^HydroArea/.test(id)) p['line-color'] = '#4989aa';
      else if (/trails|paths/.test(id)) p['line-color'] = '#965090';
      else if (id === 'ferry-route') p['line-color'] = '#4d8fab';
    }
    if (layout && 'text-field' in layout) {
      if (/contour/i.test(id)) p['text-color'] = '#88654f';
      else if (/watercourse|lake|bay|sea|reservoir|^HydroArea|^NamedWatercourse|^FuzzyExtentWaterArea/.test(id)) p['text-color'] = '#286a8a';
      else if (/roads-|road-|place|mountain|building/.test(id)) p['text-color'] = '#34453e';
      p['text-halo-color'] = '#ffffff';
      const halo = p['text-halo-width'] ?? 0;
      p['text-halo-width'] = typeof halo === 'number' ? Math.max(halo, 0.8 * factor) : halo;
      // QLD puts icon and label in one symbol with both centred on the point.
      // Collision detection does not separate parts of the same symbol. Keep
      // the icon on its location and let its name choose a free side instead.
      if (qld && 'icon-image' in layout && (!layout['symbol-placement'] || layout['symbol-placement'] === 'point')
          && !layout['text-offset'] && !layout['text-variable-anchor'] && !layout['text-anchor']) {
        layout['text-variable-anchor'] = ['top', 'bottom', 'left', 'right'];
        layout['text-radial-offset'] = 1.2;
        layout['text-justify'] = 'auto';
        layout['text-optional'] = true;
      }
    }
  }
  return copy;
}
module.exports = { profiles, getProfile, applyProfile };
