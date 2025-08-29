#!/usr/bin/env node

const maplibregl = require('@maplibre/maplibre-gl-native');
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; }
const z = parseInt(getArg('-z'));
const x1 = parseInt(getArg('-x1'));
const x2 = parseInt(getArg('-x2'));
const y1 = parseInt(getArg('-y1'));
const y2 = parseInt(getArg('-y2'));
const overwrite = args.includes('--overwrite');

if ([z, x1, x2, y1, y2].some(v => Number.isNaN(v))) {
  console.error('❌ Usage: -z Z -x1 X1 -x2 X2 -y1 Y1 -y2 Y2 [--overwrite]');
  process.exit(1);
}

// ── CONSTANTS ────────────────────────────────────────────────
// NEW: honor single-mount /data layout (or env overrides)
const DATA_DIR   = process.env.DATA_DIR   || '/data';
const tileDir    = process.env.VECTOR_DIR || path.resolve(DATA_DIR, 'vector');
const outputDir  = process.env.RASTER_DIR || path.resolve(DATA_DIR, 'raster');

// Style (kept same default); if you later pass -s or STYLE_PATH, use that
const stylePathArg = getArg('-s') || process.env.STYLE_PATH;   // no './styles/...'
if (!styleArg) { console.error('FATAL: pass -s /data/styles/style.json'); process.exit(2); }

const STYLE_PATH = path.isAbsolute(styleArg) ? styleArg : path.resolve(styleArg);
if (!fs.existsSync(STYLE_PATH)) { console.error(`FATAL: style not found at ${STYLE_PATH}`); process.exit(2); }
console.error('[WORKER] argv:', process.argv.join(' '));
console.error('[WORKER] STYLE=', STYLE_PATH);
const style = JSON.parse(fs.readFileSync(STYLE_PATH, 'utf8'));

// Keep ratio if you want hi-DPI tiles; we’ll adapt to the actual buffer size.
const ratio = 2.0;
const width = 512;
const height = 512;

// ── Helpers ──────────────────────────────────────────────────
function getTileCenter(z, x, y) {
  const n = Math.pow(2, z);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return [lng, lat];
}

// derive true pixel size from RGBA buffer length
function derivePixelSize(bufLen, logicalW, logicalH) {
  const px = bufLen / 4;
  const base = logicalW * logicalH;
  if (px === base) return [logicalW, logicalH]; // ratio == 1
  const scale = Math.sqrt(px / base);
  const w = Math.round(logicalW * scale);
  const h = Math.round(logicalH * scale);
  if (w * h * 4 !== bufLen) throw new Error(`Pixel buffer mismatch (len=${bufLen})`);
  return [w, h];
}

async function renderTile(z, x, y, index, total) {
  return new Promise((resolve) => {
    const tilePath = path.join(outputDir, String(z), String(x));
    const outPath = path.join(tilePath, `${y}.png`);
    if (!overwrite && fs.existsSync(outPath)) return resolve();

    // Transparent canvas (alpha enabled)
    let canvas = createCanvas(width, height, { alpha: true });
    let ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, width, height);

    const map = new maplibregl.Map({
      request: (req, callback) => {
        // Vector PBFs
        const tileMatch = req.url.match(/\/vector\/(\d+)\/(\d+)\/(\d+)\.pbf/);
        if (tileMatch) {
          const [zStr, xStr, yStr] = tileMatch.slice(1);
          const pbfPath = path.join(tileDir, zStr, xStr, `${yStr}.pbf`);
          return fs.readFile(pbfPath, (err, data) => {
            if (err) {
              fs.appendFileSync('failed_tiles.log', `Missing tile: z${zStr} x${xStr} y${yStr}\n`);
              return callback(null, {}); // let renderer handle gracefully (transparent)
            }
            callback(null, { data });
          });
        }
        // Fonts
        const fontMatch = req.url.match(/\/fonts\/([^/]+)\/(\d+-\d+)\.pbf/);
        if (fontMatch) {
          const [fontstackRaw, range] = fontMatch.slice(1);
          const fontstack = decodeURIComponent(fontstackRaw);
          const fontPath = path.join(__dirname, './fonts', fontstack, `${range}.pbf`);
          return fs.readFile(fontPath, (err, data) => {
            if (err) {
              fs.appendFileSync('failed_tiles.log', `Font fetch failed: ${fontPath}\n`);
              return callback(null, {});
            }
            callback(null, { data });
          });
        }
        fs.appendFileSync('failed_tiles.log', `Unknown request: ${req.url}\n`);
        callback(null, {});
      },
      ratio,
      mode: 'tile',
      width,
      height
    });

    // Ensure transparent background (belt & suspenders)
    const styleCopy = JSON.parse(JSON.stringify(style));
    const bg = styleCopy.layers.find(l => l.type === 'background');
    if (!bg) {
      styleCopy.layers.unshift({ id: 'background', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)' } });
    } else {
      bg.paint = bg.paint || {};
      bg.paint['background-color'] = 'rgba(0,0,0,0)';
    }

    map.load(styleCopy);

    const center = getTileCenter(z, x + 0.5, y + 0.5);
    map.render({ zoom: z, center, width, height, bearing: 0, pitch: 0, buffer: 256 }, (err, pixelData) => {
      if (err) {
        fs.appendFileSync('failed_tiles.log', `Render error: z${z} x${x} y${y}: ${err}\n`);
        map.release();
        return resolve();
      }

      // Resize canvas if the buffer is hi-DPI
      let outW, outH;
      try { [outW, outH] = derivePixelSize(pixelData.length, width, height); }
      catch (e) {
        fs.appendFileSync('failed_tiles.log', `Pixel mismatch: z${z} x${x} y${y}: ${e}\n`);
        map.release();
        return resolve();
      }
      if (outW !== canvas.width || outH !== canvas.height) {
        canvas = createCanvas(outW, outH, { alpha: true });
        ctx = canvas.getContext('2d', { alpha: true });
        ctx.clearRect(0, 0, outW, outH);
      }

      // Paint RGBA straight onto transparent canvas (no white flatten!)
      const imageData = ctx.createImageData(outW, outH);
      imageData.data.set(pixelData);
      ctx.putImageData(imageData, 0, 0);

      // Write PNG with alpha preserved
      fs.mkdirSync(tilePath, { recursive: true });
      const out = fs.createWriteStream(outPath);
      const stream = canvas.createPNGStream(); // retains alpha channel
      stream.pipe(out);

      out.on('finish', () => {
        map.release();
        resolve();
      });
      out.on('error', (e) => {
        fs.appendFileSync('failed_tiles.log', `Write error: z${z} x${x} y${y}: ${e}\n`);
        map.release();
        resolve();
      });
    });
  });
}

// ── MAIN LOOP ────────────────────────────────────────────────
(async () => {
  const total = (x2 - x1 + 1) * (y2 - y1 + 1);
  let i = 0;
  for (let x = x1; x <= x2; x++) {
    for (let y = y1; y <= y2; y++) {
      i++;
      await renderTile(z, x, y, i, total);
      global.gc?.();
    }
  }
})();