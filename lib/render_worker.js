#!/usr/bin/env node
// lib/render_worker.js
const fs = require("fs");
const path = require("path");
const maplibregl = require("@maplibre/maplibre-gl-native");
const { createCanvas } = require("canvas");

// --- tiny arg parser ---
const argv = process.argv.slice(2);
const getArg = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : undefined; };

const z  = parseInt(getArg("-z"), 10);
const x1 = parseInt(getArg("-x1"), 10);
const x2 = parseInt(getArg("-x2"), 10);
const y1 = parseInt(getArg("-y1"), 10);
const y2 = parseInt(getArg("-y2"), 10);

const STYLE_PATH = process.env.STYLE_PATH || getArg("-s");
const DATA_DIR   = process.env.DATA_DIR   || "/data";
const VECTOR_DIR = process.env.VECTOR_DIR || path.join(DATA_DIR, "vector");
const RASTER_DIR = process.env.RASTER_DIR || path.join(DATA_DIR, "raster");
const FONT_DIR   = process.env.FONT_DIR   || path.join(__dirname, "..", "assets", "fonts");

if (![z, x1, x2, y1, y2].every(Number.isFinite)) {
  console.error("[RDR] FATAL: Usage: -z Z -x1 X1 -x2 X2 -y1 Y1 -y2 Y2");
  process.exit(2);
}
if (!STYLE_PATH) {
  console.error("[RDR] FATAL: STYLE_PATH not set");
  process.exit(2);
}
if (!fs.existsSync(STYLE_PATH)) {
  console.error(`[RDR] FATAL: style not found at ${STYLE_PATH}`);
  process.exit(2);
}

console.log(`[WORKER] argv: ${process.execPath} ${process.argv.slice(1).join(" ")}`);
console.log(`[WORKER] STYLE= ${STYLE_PATH}`);

const ratio  = 2.0;
const width  = 512;
const height = 512;

function getTileCenter(z, x, y) {
  const n = Math.pow(2, z);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return [lng, lat];
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

async function renderOne(z, x, y) {
  return new Promise((resolve, reject) => {
    const outDir  = path.join(RASTER_DIR, String(z), String(x));
    const outPath = path.join(outDir, `${y}.png`);
    ensureDir(outDir);

    // transparent canvas
    let canvas = createCanvas(width, height, { alpha: true });
    let ctx = canvas.getContext("2d", { alpha: true });
    ctx.clearRect(0, 0, width, height);

    const map = new maplibregl.Map({
      request: (req, cb) => {
        // /vector/z/x/y.pbf
        const t = req.url.match(/\/vector\/(\d+)\/(\d+)\/(\d+)\.pbf/);
        if (t) {
          const [zStr, xStr, yStr] = t.slice(1);
          const p = path.join(VECTOR_DIR, zStr, xStr, `${yStr}.pbf`);
          return fs.readFile(p, (err, data) => cb(null, err ? {} : { data }));
        }
        // /fonts/<fontstack>/<range>.pbf  (also accept /assets/fonts/..)
        const f = req.url.match(/\/(?:assets\/)?fonts\/([^/]+)\/(\d+-\d+)\.pbf/);
        if (f) {
          const [fontstackRaw, range] = f.slice(1);
          const fontstack = decodeURIComponent(fontstackRaw);
          const p = path.join(FONT_DIR, fontstack, `${range}.pbf`);
          return fs.readFile(p, (err, data) => cb(null, err ? {} : { data }));
        }
        // unknown request -> empty
        cb(null, {});
      },
      ratio,
      mode: "tile",
      width,
      height,
    });

    // load style (force transparent background)
    let style;
    try {
      style = JSON.parse(fs.readFileSync(STYLE_PATH, "utf8"));
    } catch (e) {
      console.error(`[RDR] FATAL: cannot read style: ${e.message}`);
      return reject(e);
    }
    const bg = (style.layers || []).find((l) => l.type === "background");
    if (bg) {
      bg.paint = bg.paint || {};
      bg.paint["background-color"] = "rgba(0,0,0,0)";
    } else {
      style.layers = style.layers || [];
      style.layers.unshift({ id: "background", type: "background", paint: { "background-color": "rgba(0,0,0,0)" } });
    }

    map.load(style);

    const center = getTileCenter(z, x + 0.5, y + 0.5);
    map.render({ zoom: z, center, width, height, bearing: 0, pitch: 0, buffer: 256 }, (err, pixels) => {
      if (err) {
        console.error(`Render error: z${z} x${x} y${y}: ${err}`);
        map.release();
        return reject(err);
      }
      const img = ctx.createImageData(width, height);
      try { img.data.set(pixels); } catch (e) {
        console.error(`Pixel mismatch: z${z} x${x} y${y}: ${e}`);
        map.release();
        return reject(e);
      }
      ctx.putImageData(img, 0, 0);

      const out = fs.createWriteStream(outPath);
      canvas.createPNGStream().pipe(out);
      out.on("finish", () => { map.release(); resolve(outPath); });
      out.on("error",  (e) => { map.release(); reject(e); });
    });
  });
}

(async () => {
  for (let xx = x1; xx <= x2; xx++) {
    for (let yy = y1; yy <= y2; yy++) {
      await renderOne(z, xx, yy);
      global.gc?.();
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(`[RDR] FATAL: ${e.message}`);
  process.exit(1);
});