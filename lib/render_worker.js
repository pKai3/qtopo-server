#!/usr/bin/env node

// lib/render_worker.js (minimal move-only version)
// - reads env: DATA_DIR, VECTOR_DIR, RASTER_DIR, STYLE_PATH, FONT_DIR
// - renders one or more tiles (x1..x2, y1..y2) to PNGs under RASTER_DIR
// - no refactors; only path/env adjustments and ratio=1 to avoid buffer mismatch

const maplibregl = require('@maplibre/maplibre-gl-native');
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// ── CLI args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; }

const z  = parseInt(getArg('-z'), 10);
const x1 = parseInt(getArg('-x1'), 10);
const x2 = parseInt(getArg('-x2'), 10);
const y1 = parseInt(getArg('-y1'), 10);
const y2 = parseInt(getArg('-y2'), 10);

if ([z, x1, x2, y1, y2].some(n => !Number.isInteger(n))) {
  console.error('[RDR] FATAL: usage: -z Z -x1 X1 -x2 X2 -y1 Y1 -y2 Y2');
  process.exit(2);
}

console.log(`[RDR-W] [WORKER] argv: ${process.argv.join(' ')}`);

// ── Paths from env (provided by server.js) ─────────────────────────────────────
const DATA_DIR   = process.env.DATA_DIR   || '/data';
const VECTOR_DIR = process.env.VECTOR_DIR || path.join(DATA_DIR, 'vector');
const RASTER_DIR = process.env.RASTER_DIR || path.join(DATA_DIR, 'raster');
const STYLE_PATH = process.env.STYLE_PATH || path.join(DATA_DIR, 'styles', 'style.json');
const FONT_DIR   = process.env.FONT_DIR   || path.join(__dirname, '..', 'assets', 'fonts');

console.log(`[RDR-W] [WORKER] STYLE= ${STYLE_PATH}`);

// ── Constants ──────────────────────────────────────────────────────────────────
const width = 512;
const height = 512;

// Convert tile XYZ to tile center lon/lat
function getTileCenter(zz, xx, yy) {
  const n = Math.pow(2, zz);
  const lng = (xx / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n)));
  const lat = (latRad * 180) / Math.PI;
  return [lng, lat];
}

// ── Render one tile to file ────────────────────────────────────────────────────
async function renderTileOnce(z, x, y) {
  return new Promise((resolve, reject) => {
    const outDir  = path.join(RASTER_DIR, String(z), String(x));
    const outPath = path.join(outDir, `${y}.png`);

    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

    // canvas (no HiDPI multiply; we fix ratio below)
    let canvas = createCanvas(width, height);
    let ctx = canvas.getContext('2d');

    // request handler: serve local vector pbf + fonts from disk
    const request = (req, callback) => {
      // vector tiles as referenced by style (e.g. "/vector/z/x/y.pbf")
      const mTile = req.url.match(/\/vector\/(\d+)\/(\d+)\/(\d+)\.pbf/);
      if (mTile) {
        const [zStr, xStr, yStr] = mTile.slice(1);
        const pbfPath = path.join(VECTOR_DIR, zStr, xStr, `${yStr}.pbf`);
        return fs.readFile(pbfPath, (err, data) => {
          if (err || !data || data.length === 0) return callback(null, {}); // no data -> transparent
          callback(null, { data });
        });
      }

      // fonts (e.g. "/fonts/Open%20Sans%20Regular%2cArial%20Unicode%20MS%20Regular/0-255.pbf")
      const mFont = req.url.match(/\/fonts\/([^/]+)\/(\d+-\d+)\.pbf/);
      if (mFont) {
        const [fontstackRaw, range] = mFont.slice(1);
        const fontstack = decodeURIComponent(fontstackRaw);
        const fontPath = path.join(FONT_DIR, fontstack, `${range}.pbf`);
        return fs.readFile(fontPath, (err, data) => {
          if (err || !data) return callback(null, {});
          callback(null, { data });
        });
      }

      // anything else -> empty
      return callback(null, {});
    };

    // Maplibre map in tile mode, ratio=1 to match 512x512 canvas
    const map = new maplibregl.Map({
      request,
      mode: 'tile',
      ratio: 1,
      width,
      height
    });

    let style;
    try {
      style = JSON.parse(fs.readFileSync(STYLE_PATH, 'utf8'));
    } catch (e) {
      console.error(`[RDR] FATAL: style read failed: ${e.message}`);
      map.release();
      return reject(e);
    }

    // enforce transparent background (no-op if already transparent)
    const bg = (style.layers || []).find(l => l.type === 'background');
    if (!bg) {
      style.layers = [{ id: 'background', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)' } }, ...(style.layers || [])];
    } else {
      bg.paint = bg.paint || {};
      bg.paint['background-color'] = 'rgba(0,0,0,0)';
    }

    try { map.load(style); }
    catch (e) {
      console.error(`[RDR] FATAL: style load failed: ${e.message}`);
      map.release();
      return reject(e);
    }

    const center = getTileCenter(z, x + 0.5, y + 0.5);
    map.render({ zoom: z, center, width, height, bearing: 0, pitch: 0, buffer: 256 }, (err, pixelData) => {
      if (err) {
        console.error(`Render error: z${z} x${x} y${y}: ${err}`);
        map.release();
        return reject(err);
      }

      try {
        const imageData = ctx.createImageData(width, height);
        imageData.data.set(pixelData);         // lengths match because ratio=1
        ctx.putImageData(imageData, 0, 0);
      } catch (e) {
        console.error(`Pixel mismatch: z${z} x${x} y${y}: ${e}`);
        map.release();
        return reject(e);
      }

      const out = fs.createWriteStream(outPath);
      canvas.createPNGStream().pipe(out);

      out.on('finish', () => { map.release(); resolve(outPath); });
      out.on('error',  (e) => { map.release(); reject(e); });
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  try {
    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        await renderTileOnce(z, x, y);
      }
    }
    process.exit(0);
  } catch (e) {
    console.error(`[RDR] FATAL: ${e.message || e}`);
    process.exit(1);
  }
})();