// ─────────────────────────────────────────────────────────────
// Unbuffered logs (handy under Docker) + standardized format
// ─────────────────────────────────────────────────────────────
const util = require("util");
const processStdout = process.stdout;
const ANSI = { reset:"\x1b[0m", red:"\x1b[31m", yellow:"\x1b[33m" };
function utcNow(){ return new Date().toISOString(); }
function formatLine(level, args){
  const s = util.format(...args);
  // If caller prefixes with [TAG], lift it into the TAG field
  const m = s.match(/^\s*\[([A-Za-z0-9\-\/]+)\]\s*:??\s*(.*)$/);
  const tag = m ? m[1] : "SYS";
  const body = m ? m[2] : s;
  const color = level==="ERR" ? ANSI.red : (level==="WRN" ? ANSI.yellow : "");
  return `${color}[${level}] [${utcNow()}] [${tag}]: ${body}${ANSI.reset}`;
}
console.log  = (...args) => processStdout.write(formatLine("LOG", args) + "\n");
console.warn = (...args) => processStdout.write(formatLine("WRN", args) + "\n");
console.error= (...args) => processStdout.write(formatLine("ERR", args) + "\n");

// ─────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────
const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// ─────────────────────────────────────────────────────────────
// Config / env
// ─────────────────────────────────────────────────────────────
const app = express();
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

const DATA_DIR = process.env.DATA_DIR || "/data";
const VECTOR_DIR = process.env.VECTOR_DIR || path.join(DATA_DIR, "vector");
const RASTER_DIR = process.env.RASTER_DIR || path.join(DATA_DIR, "raster");

// baked style (in image) and editable style (on host volume)
/* eslint-disable no-unused-vars */
const BAKED_STYLE = path.join(__dirname, "public", "style.json"); // image
const STYLE_DIR   = process.env.STYLE_DIR || path.join(DATA_DIR, "styles"); // host
const STYLE_PATH  = process.env.STYLE_PATH || path.join(STYLE_DIR, "style.json");

const BLANK_TILE_PATH = process.env.BLANK_TILE_PATH || path.join(__dirname, "assets", "images", "blank.png");
const ERROR_TILE_PATH = process.env.ERROR_TILE_PATH || path.join(__dirname, "assets", "images", "error.png");

const CLEANUP_INTERVAL_MINUTES = Number(process.env.CLEANUP_INTERVAL_MINUTES || 15);
const RASTER_TTL_HOURS = Number(process.env.RASTER_TTL_HOURS || 72);
const VECTOR_TTL_HOURS = Number(process.env.VECTOR_TTL_HOURS || 0); // 0 => ∞

const NODE_BIN = process.env.NODE_BIN || process.execPath;

// Upstream vector tile template
const VECTOR_BASE_URL = process.env.VECTOR_BASE_URL ||
  "https://spatial.information.qld.gov.au/arcgis/rest/services/Hosted/Basemaps_QldBase_Topographic/VectorTileServer/tile";

// ─────────────────────────────────────────────────────────────
// Static assets & viewer
// ─────────────────────────────────────────────────────────────
app.use("/fonts", express.static(path.join(__dirname, "assets", "fonts")));
app.use("/images", express.static(path.join(__dirname, "assets", "images")));
app.use("/",       express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function absJoin(base, ...parts) { const p = path.join(base, ...parts); ensureDir(path.dirname(p)); return p; }

function setTileHeaders(res) {
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
}

function sendTileFile(res, absPath) {
  setTileHeaders(res);
  return res.sendFile(absPath);
}

// 1×1 transparent PNG fallback
let FALLBACK_BLANK = null;
function loadBlankOnce() {
  try {
    FALLBACK_BLANK = fs.readFileSync(BLANK_TILE_PATH);
  } catch {
    // generate 1×1 transparent if missing
    const { createCanvas } = require("canvas");
    const c = createCanvas(1,1);
    const buf = c.toBuffer("image/png");
    FALLBACK_BLANK = buf;
  }
  console.log(`[INIT] Created fallback blank tile at ${BLANK_TILE_PATH}`);
}

// style seeding (copy baked → editable if missing)
function seedStyleIfMissing() {
  try {
    ensureDir(path.dirname(STYLE_PATH));
    if (!fs.existsSync(STYLE_PATH)) {
      fs.copyFileSync(BAKED_STYLE, STYLE_PATH);
      console.warn(`[SEED] missing style; seeded editable at ${STYLE_PATH}`);
    }
    if (!fs.existsSync(STYLE_PATH)) {
      console.error(`[BOOT] FATAL: editable style missing at ${STYLE_PATH}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`[BOOT] FATAL: style seeding/validation failed: ${e.message}`);
    process.exit(2);
  }
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

// Redirect old prefix → new
app.get(/^\/tiles_raster\/(\d+)\/(\d+)\/(\d+)\.png$/, (req, res) => {
  const [ , z, x, y ] = req.params;
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, `/raster/${z}/${x}/${y}.png${qs}`);
});

// Vector tile fetch+cache
const inflightPbf = new Map();
async function ensureVectorTile(zStr, xStr, yStr) {
  const outPath = absJoin(VECTOR_DIR, zStr, xStr, `${yStr}.pbf`);
  try {
    await fs.promises.access(outPath);
    console.log(`[PBF] Exists: ${outPath}`);
    return outPath;
  } catch {}

  const key = `${zStr}/${xStr}/${yStr}`;
  if (inflightPbf.has(key)) {
    console.log(`[PBF] Awaiting in-flight download: ${key}`);
    return inflightPbf.get(key);
  }

  const p = (async () => {
    try {
      const url = `${VECTOR_BASE_URL}/${zStr}/${yStr}/${xStr}.pbf`; // …/tile/{z}/{y}/{x}.pbf
      console.log(`[PBF-GET] /${zStr}/${xStr}/${yStr}/ ${url}`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
      await fs.promises.writeFile(outPath, buf);
      console.log(`[PBF] Saved: ${outPath} (${buf.length} bytes)`);
      return outPath;
    } catch (e) {
      console.error(`[PBF-ERR] ${key}: ${e && e.message ? e.message : e}`);
      throw e;
    } finally {
      inflightPbf.delete(key);
    }
  })();

  inflightPbf.set(key, p);
  return p;
}

app.get(/^\/vector\/(\d+)\/(\d+)\/(\d+)\.pbf$/, async (req, res) => {
  const [ , zStr, xStr, yStr ] = req.params;
  try {
    const abs = await ensureVectorTile(zStr, xStr, yStr);
    res.type("application/x-protobuf");
    setTileHeaders(res);
    res.sendFile(abs);
  } catch (e) {
    console.error(`[PBF-SEND-ERR] ${zStr}/${xStr}/${yStr}: ${e?.message || e}`);
    res.sendStatus(502);
  }
});

// Raster request
app.get(/^\/raster\/(\d+)\/(\d+)\/(\d+)\.png$/, async (req, res) => {
  const [ , zStr, xStr, yStr ] = req.params;
  console.log(`[REQ] GET /raster/${zStr}/${xStr}/${yStr}.png`);

  const tilePath = absJoin(RASTER_DIR, zStr, xStr, `${yStr}.png`);
  if (fs.existsSync(tilePath)) {
    console.log(`[CACHE] ${tilePath}`);
    return sendTileFile(res, tilePath);
  }

  try {
    const pbfPath = await ensureVectorTile(zStr, xStr, yStr);
    await renderSingleTile(zStr, xStr, yStr, tilePath, pbfPath);
    return sendTileFile(res, tilePath);
  } catch (e) {
    console.error(`[FAIL] Rendering failed for ${zStr}/${xStr}/${yStr}: ${e.message || e}`);
    try {
      await fs.promises.copyFile(BLANK_TILE_PATH, tilePath);
      console.log(`[BLANK-TILE] Wrote transparent tile -> ${tilePath} (RENDER ERR)`);
      return sendTileFile(res, tilePath);
    } catch (copyErr) {
      console.error(`[BLANK-TILE] Cache copy failed: ${copyErr.message}`);
      res.type("image/png").send(FALLBACK_BLANK);
    }
  }
});

// Serve active style (makes relative glyphs/tiles absolute to this host)
app.get('/style.json', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const ensureAbs = u => /^https?:\/\//.test(u) ? u : origin + (u.startsWith('/') ? u : '/' + u);

  const raw = fs.readFileSync(STYLE_PATH, 'utf8');
  const style = JSON.parse(raw);

  style.glyphs = ensureAbs(style.glyphs || '/fonts/{fontstack}/{range}.pbf');
  if (style.sources) {
    for (const src of Object.values(style.sources)) {
      if (Array.isArray(src.tiles)) src.tiles = src.tiles.map(ensureAbs);
    }
  }
  res.type('application/json; charset=utf-8').send(style);
});

// ─────────────────────────────────────────────────────────────
// Render worker spawn
// ─────────────────────────────────────────────────────────────
async function renderSingleTile(zStr, xStr, yStr, tilePath, pbfPath) {
  console.log(`[RENDER] Generating tile: ${tilePath}`);

  const args = [
    "render_worker.js",
    "-z", zStr, "-x1", xStr, "-x2", xStr, "-y1", yStr, "-y2", yStr
  ];

  const env = { ...process.env, PATH: `${path.dirname(NODE_BIN)}:${process.env.PATH || ""}`, STYLE_PATH };
  const child = spawn(NODE_BIN, args, { cwd: __dirname, env });

  child.stdout.on("data", (d) => { const line=String(d).trimEnd(); if(line) console.log(`[RDR] ${line}`); });
  child.stderr.on("data", (d) => { const line=String(d).trimEnd(); if(line) console.error(`[RDR] ${line}`); });

  await new Promise((resolve) => child.on("close", () => resolve()));
  if (!fs.existsSync(tilePath)) throw new Error("render_worker produced no PNG");
}

// ─────────────────────────────────────────────────────────────
// Cleanup (TTL)
// ─────────────────────────────────────────────────────────────
let cleanupTimer = null;
let cleanupRunning = false;

function ttlDesc(hours) { return Number(hours) === 0 ? "∞" : `${hours}h`; }

async function cleanupOldFiles(dir, ttlHours) {
  if (Number(ttlHours) === 0) return { deleted: 0 }; // disabled
  const cutoff = Date.now() - Number(ttlHours)*3600*1000;
  let deleted = 0;
  const walk = async (p) => {
    const ents = await fs.promises.readdir(p, { withFileTypes: true });
    for (const e of ents) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) { await walk(fp); continue; }
      const st = await fs.promises.stat(fp);
      if (st.mtimeMs < cutoff) { await fs.promises.unlink(fp); deleted++; }
    }
  };
  try { await walk(dir); } catch {}
  return { deleted };
}

async function runCleanupOnce(reason) {
  if (cleanupRunning) { console.log(`[CLEANUP] Deferred (${reason}); another pass is already running`); return; }
  cleanupRunning = true;
  console.log(`[CLEANUP] Start (${reason})  raster TTL=${ttlDesc(RASTER_TTL_HOURS)}, vector TTL=${ttlDesc(VECTOR_TTL_HOURS)}`);
  const start = Date.now();
  try {
    let delRaster = 0, delVector = 0;
    if (Number(RASTER_TTL_HOURS) === 0) {
      console.log("[CLEANUP] Skipping raster tree (TTL=∞)");
    } else {
      const r = await cleanupOldFiles(RASTER_DIR, RASTER_TTL_HOURS);
      delRaster = r.deleted;
    }
    if (Number(VECTOR_TTL_HOURS) === 0) {
      console.log("[CLEANUP] Skipping vector tree (TTL=∞)");
    } else {
      const v = await cleanupOldFiles(VECTOR_DIR, VECTOR_TTL_HOURS);
      delVector = v.deleted;
    }
    console.log(`[CLEANUP] Done in ${Date.now() - start} ms  deleted: raster=${delRaster}, vector=${delVector}`);
  } catch (e) {
    console.error(`[CLEANUP] Error: ${e.message || e}`);
  } finally {
    cleanupRunning = false;
    if (CLEANUP_INTERVAL_MINUTES > 0) {
      console.log(`[CLEANUP] Next pass in ${Math.round(CLEANUP_INTERVAL_MINUTES)} min`);
    } else {
      console.log("[CLEANUP] Disabled");
    }
  }
}

function scheduleCleanup() {
  if (CLEANUP_INTERVAL_MINUTES <= 0) return;
  console.log(`[CLEANUP] Scheduled every ${CLEANUP_INTERVAL_MINUTES} min`);
  const loop = async () => {
    await runCleanupOnce("scheduled");
    cleanupTimer = setTimeout(loop, CLEANUP_INTERVAL_MINUTES*60*1000);
  };
  cleanupTimer = setTimeout(loop, CLEANUP_INTERVAL_MINUTES*60*1000);
}

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
ensureDir(VECTOR_DIR);
ensureDir(RASTER_DIR);
ensureDir(STYLE_DIR);
loadBlankOnce();
seedStyleIfMissing();

// start scheduler once at boot
scheduleCleanup();

// graceful shutdown
process.on("SIGTERM", () => { if (cleanupTimer) clearTimeout(cleanupTimer); });
process.on("SIGINT",  () => { if (cleanupTimer) clearTimeout(cleanupTimer); });

// ─────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`[INIT] VECTOR_DIR=${VECTOR_DIR}`);
  console.log(`[INIT] RASTER_DIR=${RASTER_DIR}`);
  console.log(`Tile server running on http://${HOST}:${PORT}`);
});