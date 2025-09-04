#!/usr/bin/env node
// ── LOG SHIM (UTC + colors + tag capture) ───────────────────
const util = require('util');
const out = process.stdout;
const ANSI = { reset:"\x1b[0m", red:"\x1b[31m", yellow:"\x1b[33m" };
const utcNow = () => new Date().toISOString();
const fmt = (lvl, args) => {
  const s = util.format(...args);
  const m = s.match(/^\s*\[([A-Za-z0-9\-\/]+)\]\s*:??\s*(.*)$/);
  const tag = m ? m[1] : 'RDR';
  const body = m ? m[2] : s;
  const color = lvl==='ERR' ? ANSI.red : (lvl==='WRN' ? ANSI.yellow : '');
  return `${color}[${lvl}] [${utcNow()}] [${tag}]: ${body}${ANSI.reset}`;
};
console.log  = (...a) => out.write(fmt('LOG', a) + '\n');
console.warn = (...a) => out.write(fmt('WRN', a) + '\n');
console.error= (...a) => out.write(fmt('ERR', a) + '\n');

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
  console.error('[RDR] ❌ Usage: -z Z -x1 X1 -x2 X2 -y1 Y1 -y2 Y2 [--overwrite]');
  process.exit(1);
}

// ── CONSTANTS ────────────────────────────────────────────────
const DATA_DIR   = process.env.DATA_DIR   || '/data';
const tileDir    = process.env.VECTOR_DIR || path.resolve(DATA_DIR, 'vector');
const outputDir  = process.env.RASTER_DIR || path.resolve(DATA_DIR, 'raster');

// Style path: required via env or -s
const styleArg = getArg('-s') || process.env.STYLE_PATH;
if (!styleArg) { console.error('[RDR] FATAL: STYLE_PATH env (or -s) required'); process.exit(2); }
const STYLE_PATH = path.isAbsolute(styleArg) ? styleArg : path.resolve(styleArg);
if (!fs.existsSync(STYLE_PATH)) { console.error(`\[RDR] FATAL: style not found at ${STYLE_PATH}`); process.exit(2); }
console.log(`[RDR] argv: ${process.argv.join(' ')}`);
console.log(`[RDR] style: ${STYLE_PATH}`);

const style = JSON.parse(fs.readFileSync(STYLE_PATH, 'utf8'));
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
  if (px === base) return [logicalW, logicalH];
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
            if (err) { console.warn(`[PBF] missing z${zStr} x${xStr} y${yStr}`); return callback(null, {}); }
            callback(null, { data });
          });
        }

        // Fonts
        const fontMatch = req.url.match(/\/fonts\/([^/]+)\/(\d+-\d+)\.pbf/);
        if (fontMatch) {
          const [fontstackRaw, range] = fontMatch.slice(1);
          const fontstack = decodeURIComponent(fontstackRaw);
          const fontPath = path.join(__dirname, './assets/fonts', fontstack, `${range}.pbf`);
          return fs.readFile(fontPath, (err, data) => {
            if (err) { console.warn(`[FONT] fetch failed: ${fontPath}`); return callback(null, {}); }
            callback(null, { data });
          });
        }

        console.warn(`[RDR] unknown request: ${req.url}`);
        callback(null, {});
      },
      ratio,
      mode: 'tile',
      width,
      height
    });

    // Force transparent background
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
        console.error(`[RDR] render error: z${z} x${x} y${y}: ${err}`);
        map.release();
        return resolve();
      }

      let outW, outH;
      try { [outW, outH] = derivePixelSize(pixelData.length, width, height); }
      catch (e) {
        console.error(`[RDR] pixel mismatch: z${z} x${x} y${y}: ${e}`);
        map.release();
        return resolve();
      }

      if (outW !== canvas.width || outH !== canvas.height) {
        canvas = createCanvas(outW, outH, { alpha: true });
        ctx = canvas.getContext('2d', { alpha: true });
        ctx.clearRect(0, 0, outW, outH);
      }

      const imageData = ctx.createImageData(outW, outH);
      imageData.data.set(pixelData);
      ctx.putImageData(imageData, 0, 0);

      fs.mkdirSync(tilePath, { recursive: true });
      const out = fs.createWriteStream(outPath);
      const stream = canvas.createPNGStream();
      stream.pipe(out);

      out.on('finish', () => {
        map.release();
        resolve();
      });

      out.on('error', (e) => {
        console.error(`[RDR] write error: z${z} x${x} y${y}: ${e}`);
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