#!/usr/bin/env node

const maplibregl = require('@maplibre/maplibre-gl-native');
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; }

const z  = parseInt(getArg('-z'));
const x1 = parseInt(getArg('-x1'));
const x2 = parseInt(getArg('-x2'));
const y1 = parseInt(getArg('-y1'));
const y2 = parseInt(getArg('-y2'));
const outPathArg = getArg('-o') ? path.resolve(getArg('-o')) : null;
const overwrite = args.includes('--overwrite');

const DEBUG = process.env.RENDER_DEBUG === '1' || args.includes('--debug');

// Style path resolution (ENV or param, fallback to image default)
const stylePathArg =
  getArg('-s') ||
  process.env.STYLE_PATH ||
  path.resolve(__dirname, 'styles', 'style.json');

// ── PARAM CHECKS ─────────────────────────────────────────────
if ([z, x1, x2, y1, y2].some(v => Number.isNaN(v))) {
  console.error('❌ Usage: -z Z -x1 X1 -x2 X2 -y1 Y1 -y2 Y2 [-o out.png] [-s style.json] [--overwrite] [--debug]');
  process.exit(1);
}
if (!fs.existsSync(stylePathArg)) {
  console.error(`❌ Style not found: ${stylePathArg}`);
  process.exit(2);
}

// ── CONSTANTS ────────────────────────────────────────────────
const DATA_DIR   = process.env.DATA_DIR   || '/data';
const VECTOR_DIR = process.env.VECTOR_DIR || path.resolve(DATA_DIR, 'vector');
const RASTER_DIR = process.env.RASTER_DIR || path.resolve(DATA_DIR, 'raster');

const VECTOR_TILES_URL = process.env.VECTOR_TILES_URL || '/vector/{z}/{x}/{y}.pbf';
const TILE_SIZE   = parseInt(getArg('--tile') || process.env.TILE_SIZE || '512');
const RATIO       = parseFloat(getArg('--ratio') || process.env.RENDER_PIXEL_RATIO || '1') || 1;

const WIDTH = TILE_SIZE;
const HEIGHT = TILE_SIZE;

// ── Helpers ──────────────────────────────────────────────────
function getTileCenter(z, x, y) {
  const n = Math.pow(2, z);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return [lng, lat];
}

function derivePixelSize(bufLen, w, h) {
  const px = bufLen / 4;
  const base = w * h;
  if (px === base) return [w, h];
  const scale = Math.sqrt(px / base);
  const W = Math.round(w * scale), H = Math.round(h * scale);
  if (W * H * 4 !== bufLen) throw new Error(`Pixel buffer mismatch len=${bufLen}, expected=${W*H*4}`);
  return [W, H];
}

function loadAndSanitizeStyle(p) {
  const json = fs.readFileSync(p, 'utf8');
  let s;
  try { s = JSON.parse(json); }
  catch (e) {
    console.error(`❌ Style JSON parse error in ${p}: ${e.message}`);
    process.exit(3);
  }

  // Ensure transparent background
  const bg = (s.layers || []).find(l => l.type === 'background');
  if (!bg) {
    s.layers = [{ id: '__bg', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)' } }, ...(s.layers || [])];
  } else {
    bg.paint = bg.paint || {};
    bg.paint['background-color'] = 'rgba(0,0,0,0)';
  }

  // Force glyphs to local fonts handler
  s.glyphs = 'fonts/{fontstack}/{range}.pbf';

  // Remove sprite reference (remote sprite JSON/PNG often crashes native renderer)
  if (s.sprite) {
    if (DEBUG) console.error(`[STYLE] removing sprite reference: ${s.sprite}`);
    delete s.sprite;
  }

  // Coerce vector sources to our local /vector URL + xyz scheme
  const srcIds = Object.keys(s.sources || {});
  const vecIds = srcIds.filter(id => s.sources[id]?.type === 'vector');
  for (const id of vecIds) {
    const src = s.sources[id];
    if (!Array.isArray(src.tiles) || src.tiles.length === 0) {
      src.tiles = [VECTOR_TILES_URL];
    }
    // If not our endpoint, force it
    if (!/^\/vector\/\{z\}\/\{x\}\/\{y\}\.pbf$/.test(src.tiles[0])) {
      if (DEBUG) console.error(`[STYLE] source "${id}" tiles -> ${VECTOR_TILES_URL}`);
      src.tiles = [VECTOR_TILES_URL];
    }
    src.scheme = 'xyz';
    if (src.minzoom == null) src.minzoom = 0;
    if (src.maxzoom == null) src.maxzoom = 14;
  }

  // If any layer references a non-existent source, map it to the first vector source
  if (vecIds.length > 0) {
    for (const layer of (s.layers || [])) {
      if (layer.source && !vecIds.includes(layer.source)) {
        if (DEBUG) console.error(`[STYLE] layer "${layer.id}" source "${layer.source}" → "${vecIds[0]}"`);
        layer.source = vecIds[0];
      }
    }
  }

  if (DEBUG) {
    console.error(`[STYLE] using: ${p}`);
    console.error(`[STYLE] vector sources: ${vecIds.join(', ') || '<none>'}`);
  }

  return s;
}

// Diagnostics for crashes/signals
process.on('uncaughtException', e => { console.error(`[FATAL] uncaught: ${e.stack || e}`); process.exit(111); });
process.on('unhandledRejection', e => { console.error(`[FATAL] unhandledRejection: ${e.stack || e}`); process.exit(112); });
['SIGSEGV','SIGABRT','SIGBUS','SIGILL','SIGFPE'].forEach(sig => {
  process.on(sig, () => { console.error(`[FATAL] signal ${sig}`); process.exit(113); });
});

async function renderTile(z, x, y) {
  return new Promise((resolve) => {
    const zStr = String(z), xStr = String(x), yStr = String(y);

    // Output path
    const outDir = outPathArg ? path.dirname(outPathArg) : path.join(RASTER_DIR, zStr, xStr);
    const outPath = outPathArg || path.join(outDir, `${yStr}.png`);
    if (!overwrite && fs.existsSync(outPath)) return resolve(true);

    // Transparent canvas
    let canvas = createCanvas(WIDTH, HEIGHT, { alpha: true });
    let ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Style
    const style = loadAndSanitizeStyle(stylePathArg);

    const map = new maplibregl.Map({
      request: (req, cb) => {
        if (DEBUG) console.error(`[REQ] ${req.url}`);

        // Accept both /vector and legacy /tiles_vector
        const tm = req.url.match(/^\/(?:(?:vector)|(?:tiles_vector))\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
        if (tm) {
          const [zS, xS, yS] = tm.slice(1);
          const pbfPath = path.join(VECTOR_DIR, zS, xS, `${yS}.pbf`);
          return fs.readFile(pbfPath, (err, data) => cb(null, err ? {} : { data }));
        }

        // Fonts from image assets
        const fm = req.url.match(/^\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/);
        if (fm) {
          const [fontstackRaw, range] = fm.slice(1);
          const fontstack = decodeURIComponent(fontstackRaw);
          const fontPath = path.join(__dirname, 'assets', 'fonts', fontstack, `${range}.pbf`);
          return fs.readFile(fontPath, (err, data) => cb(null, err ? {} : { data }));
        }

        // Unknown resources: respond empty (prevents crashes)
        return cb(null, {});
      },
      ratio: RATIO,
      mode: 'tile',
      width: WIDTH,
      height: HEIGHT
    });

    const center = getTileCenter(z, x + 0.5, y + 0.5);

    try {
      map.load(style);
    } catch (e) {
      console.error(`[RENDER] style load failed: ${e.message || e}`);
      return resolve(false);
    }

    map.render({ zoom: z, center, width: WIDTH, height: HEIGHT, bearing: 0, pitch: 0, buffer: 256 }, (err, rgba) => {
      if (err) {
        console.error(`[RENDER] render error ${z}/${x}/${y}: ${err}`);
        map.release();
        return resolve(false);
      }

      let W, H;
      try { [W, H] = derivePixelSize(rgba.length, WIDTH, HEIGHT); }
      catch (e) { console.error(`[RENDER] pixel mismatch ${z}/${x}/${y}: ${e}`); map.release(); return resolve(false); }

      const outCanvas = createCanvas(W, H, { alpha: true });
      const octx = outCanvas.getContext('2d', { alpha: true });
      const img = octx.createImageData(W, H);
      img.data.set(rgba);
      octx.putImageData(img, 0, 0);

      fs.mkdirSync(outDir, { recursive: true });
      const out = fs.createWriteStream(outPath);
      outCanvas.createPNGStream().pipe(out);

      out.on('finish', () => { map.release(); resolve(true); });
      out.on('error',  (e) => { console.error(`[RENDER] write error ${z}/${x}/${y}: ${e}`); map.release(); resolve(false); });
    });
  });
}

// ── MAIN LOOP ────────────────────────────────────────────────
(async () => {
  if (DEBUG) {
    console.error(`[DBG] style=${stylePathArg}`);
    console.error(`[DBG] DATA_DIR=${DATA_DIR} VECTOR_DIR=${VECTOR_DIR} RASTER_DIR=${RASTER_DIR}`);
    console.error(`[DBG] TILE_SIZE=${TILE_SIZE} RATIO=${RATIO}`);
  }

  for (let x = x1; x <= x2; x++) {
    for (let y = y1; y <= y2; y++) {
      const ok = await renderTile(z, x, y);
      if (!ok) {
        // keep going; server will treat failure as "render err" and serve blank
      }
      global.gc?.();
    }
  }
})();