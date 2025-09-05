#!/usr/bin/env node
/* Generate MapLibre styles from a base style + profile knobs
   Usage:
     node scripts/generate_styles.js --in styles/base.style.json --profile mobile --out styles/style.mobile.json
     node scripts/generate_styles.js --profile desktop    # uses defaults, writes styles/style.desktop.json
     node scripts/generate_styles.js --profile mobile     # writes styles/style.mobile.json
*/
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const profileName = arg('--profile', 'desktop');
const basePath    = arg('--in', path.resolve('styles', 'base.style.json'));
const outPathArg  = arg('--out', null);

const profiles = JSON.parse(fs.readFileSync(path.resolve('styles', 'profiles.json'), 'utf8'));

if (!profiles[profileName]) {
  console.error(`[ERR] Unknown profile "${profileName}". Available: ${Object.keys(profiles).join(', ')}`);
  process.exit(2);
}

const profile = profiles[profileName];
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));

// ---- helpers -------------------------------------------------------
const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);

// Wrap any number/array expression to scale; keep expressions intact by multiplying
function scaleExpr(expr, mult) {
  if (mult === 1) return expr;
  if (isNum(expr)) return ['*', mult, expr];
  if (Array.isArray(expr)) return ['*', mult, expr];
  return expr;
}

// Ensure a minimum via ["max", min, expr]
function minExpr(expr, minVal) {
  if (minVal == null) return expr;
  if (isNum(expr) || Array.isArray(expr)) return ['max', minVal, expr];
  return expr;
}

function bumpLineWidth(layer, mult, minW) {
  if (!layer.paint) return;
  if ('line-width' in layer.paint) {
    let w = layer.paint['line-width'];
    w = scaleExpr(w, mult);
    w = minExpr(w, minW);
    layer.paint['line-width'] = w;
  }
}

function bumpTextSize(layer, mult) {
  if (!layer.layout) return;
  if ('text-size' in layer.layout) {
    layer.layout['text-size'] = scaleExpr(layer.layout['text-size'], mult);
  }
}

function ensureHalo(layer, minHalo) {
  if (!layer.paint) return;
  const k = 'text-halo-width';
  if (!(k in layer.paint)) {
    layer.paint[k] = minHalo;
  } else if (isNum(layer.paint[k])) {
    layer.paint[k] = Math.max(minHalo, layer.paint[k]);
  } else {
    layer.paint[k] = ['max', minHalo, layer.paint[k]];
  }
}

function setMinZoom(layer, zoom) {
  if (zoom == null) return;
  layer.minzoom = zoom;
}

function match(reArr, id) {
  return reArr.some(re => re.test(id));
}

function transform(base, profile) {
  const out = JSON.parse(JSON.stringify(base));
  out.metadata = Object.assign({}, out.metadata, {
    generated: new Date().toISOString(),
    profile: profile.name || profileName
  });

  const layers = out.layers || [];

  // Regex groups (by layer id). Tweak these to your id scheme.
  const G = {
    roadsLow:     [/^roads-low$/i],
    roadsMed:     [/^roads-medium$/i],
    roadsHigh:    [/^roads-high$/i],
    roadBridge:   [/^road-bridge\/overpass$/i, /^roads-bridge\/overpass$/i],
    waterLarge:   [/^watercourses-large$/i],
    waterSmall:   [/^watercourses-small$/i],
    coastline:    [/^coastline$/i],
    shoreline:    [/^shoreline$/i],
    trails:       [/^trails$/i, /^qpws\s*trails$/i],
    rail:         [/^railway/i],
    borders:      [/^state-border$/i],
    contours:     [/^contour-(large|medium|small)$/i, /^aux-contour-(large|medium|small)$/i],
    // labels
    roadLabels:   [/^roads-(medium|high)-labels$/i],
    waterLabels:  [/^watercourse-(large|small)-labels$/i],
    contourLabels:[/^contour-(large|medium|small)-labels$/i, /^aux-contour-labels-small$/i],
    placeLabels:  [/^populated-place-label$/i, /^mountain-label$/i, /^region-label$/i, /^beach-label$/i, /^bay-label$/i, /^airport-areas-label$/i]
  };

  for (const lyr of layers) {
    const id = lyr.id || '';

    // LINE WIDTH SCALING
    if (match(G.roadsLow, id))     bumpLineWidth(lyr, profile.lines.roads.low.mult,     profile.lines.roads.low.min);
    if (match(G.roadsMed, id))     bumpLineWidth(lyr, profile.lines.roads.medium.mult,  profile.lines.roads.medium.min);
    if (match(G.roadsHigh, id))    bumpLineWidth(lyr, profile.lines.roads.high.mult,    profile.lines.roads.high.min);
    if (match(G.roadBridge, id))   bumpLineWidth(lyr, profile.lines.roads.bridge.mult,  profile.lines.roads.bridge.min);

    if (match(G.waterLarge, id))   bumpLineWidth(lyr, profile.lines.water.large.mult,   profile.lines.water.large.min);
    if (match(G.waterSmall, id))   bumpLineWidth(lyr, profile.lines.water.small.mult,   profile.lines.water.small.min);

    if (match(G.trails, id))       bumpLineWidth(lyr, profile.lines.trails.mult,        profile.lines.trails.min);
    if (match(G.coastline, id))    bumpLineWidth(lyr, profile.lines.coastline.mult,     profile.lines.coastline.min);
    if (match(G.shoreline, id))    bumpLineWidth(lyr, profile.lines.shoreline.mult,     profile.lines.shoreline.min);
    if (match(G.rail, id))         bumpLineWidth(lyr, profile.lines.rail.mult,          profile.lines.rail.min);
    if (match(G.borders, id))      bumpLineWidth(lyr, profile.lines.borders.mult,       profile.lines.borders.min);
    if (match(G.contours, id))     bumpLineWidth(lyr, profile.lines.contours.mult,      profile.lines.contours.min);

    // TEXT SIZE + HALO
    if (match(G.roadLabels, id) || match(G.waterLabels, id) || match(G.contourLabels, id) || match(G.placeLabels, id)) {
      bumpTextSize(lyr, profile.text.sizeMult);
      ensureHalo(lyr, profile.text.minHalo);
    }

    // ZOOM GATES (reduce clutter on phones)
    const z = profile.zoomGates[id];
    if (z != null) setMinZoom(lyr, z);
    // Also allow pattern-based gates
    for (const [pat, gate] of Object.entries(profile.zoomGatePatterns || {})) {
      const re = new RegExp(pat, 'i');
      if (re.test(id)) { setMinZoom(lyr, gate); }
    }
  }

  return out;
}

// ---- run ------------------------------------------------------------
const out = transform(base, profile);

let outPath = outPathArg;
if (!outPath) {
  const name = profileName === 'desktop' ? 'style.desktop.json' : `style.${profileName}.json`;
  outPath = path.resolve('styles', name);
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`[OK] wrote ${outPath}`);