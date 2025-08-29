// ─────────────────────────────────────────────────────────────
// Unbuffered logs (handy under Docker)
// ─────────────────────────────────────────────────────────────
const util = require("util");
const processStdout = process.stdout;
console.log = (...args) => processStdout.write(util.format(...args) + "\n");
console.error = (...args) => processStdout.write("[ERR] " + util.format(...args) + "\n");

// ─────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────
const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// ─────────────────────────────────────────────────────────────
const app = express();

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

// ── NEW: single-mount data roots (defaults to /data/{vector,raster})
const DATA_DIR   = process.env.DATA_DIR   || "/data";
const RASTER_DIR = process.env.RASTER_DIR || path.join(DATA_DIR, "raster");
const VECTOR_DIR = process.env.VECTOR_DIR || path.join(DATA_DIR, "vector");

const STYLE_DIR = process.env.STYLE_DIR || path.join(DATA_DIR, "styles");
const STYLE_PATH = process.env.STYLE_PATH || path.resolve(__dirname, STYLE_DIR, 'style.json');

const BAKED_STYLE = path.join(__dirname, 'styles', 'style.json');

// Where raster tiles are written/read
const rasterRoot = RASTER_DIR;
// Where vector PBFs live
const vectorRoot = VECTOR_DIR;


// Seed editable style once, then require it
process.umask(0o002);

try {
  fs.mkdirSync(STYLE_DIR, { recursive: true });
  if (!fs.existsSync(STYLE_PATH)) {
    if (!fs.existsSync(BAKED_STYLE)) {
      console.error(`[BOOT] FATAL: baked style missing at ${BAKED_STYLE}`);
      process.exit(1);
    }
    fs.copyFileSync(BAKED_STYLE, STYLE_PATH);
    console.log(`[BOOT] seeded editable style at ${STYLE_PATH}`);
  }
  // Hard-enforce editable path only
  if (!fs.existsSync(STYLE_PATH)) {
    console.error(`[BOOT] FATAL: editable style missing at ${STYLE_PATH}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`[BOOT] FATAL: style seeding/validation failed: ${e.message}`);
  process.exit(1);
}

const PUID = parseInt(process.env.PUID || '99', 10);   // Unraid default: nobody
const PGID = parseInt(process.env.PGID || '100', 10);  // Unraid default: users

function fixPerms(p) {
  try { fs.chownSync(p, PUID, PGID); } catch {}
  try {
    const st = fs.statSync(p);
    const mode = st.isDirectory() ? 0o775 : 0o664;
    fs.chmodSync(p, mode);
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) fixPerms(path.join(p, n));
  } catch {}
}

fixPerms(STYLE_DIR);
process.env.STYLE_PATH = STYLE_PATH;  // <-- export for children

// Vector PBF Endpoint (QTopo 1m Official)
const VECTOR_BASE_URL =
  process.env.VECTOR_BASE_URL ||
  "https://spatial.information.qld.gov.au/arcgis/rest/services/Hosted/Basemaps_QldBase_Topographic/VectorTileServer/tile";

// Networking
const PBF_FETCH_TIMEOUT_MS = Number(process.env.PBF_FETCH_TIMEOUT_MS || 10000);

// Transparent blank PNG 
const BLANK_TILE_PATH = process.env.BLANK_TILE_PATH || path.join(__dirname, "assets", "images", "blank.png");
const ERROR_TILE_PATH = process.env.ERROR_TILE_PATH || path.join(__dirname, "assets", "images", "error.png");
const CACHE_BLANK_TILES = process.env.CACHE_BLANK_TILES !== "0";

// ─────────────────────────────────────────────────────────────
// Cleanup settings
// ─────────────────────────────────────────────────────────────
// Enabled by default; set CLEANUP_ENABLED=0 to disable
const CLEANUP_ENABLED = process.env.CLEANUP_ENABLED !== "0";
const CLEANUP_INTERVAL_MINUTES = Number(process.env.CLEANUP_INTERVAL_MINUTES || 15);
const RASTER_TTL_HOURS = Number(process.env.RASTER_TTL_HOURS || 1);   // default 1h
const VECTOR_TTL_HOURS = Number(process.env.VECTOR_TTL_HOURS || 0);   // default ∞
// Safety: cap deletions per run (0 = unlimited)
const CLEANUP_MAX_DELETES = Number(process.env.CLEANUP_MAX_DELETES || 0);

// 0 (or negative) means Infinity (never delete)
const toMsOrInfinity = (h) => (h > 0 ? h * 3600 * 1000 : Infinity);

// ─────────────────────────────────────────────────────────────
// Small utils
// ─────────────────────────────────────────────────────────────
const isNonNegInt = (v) => /^\d+$/.test(String(v));

function zxysToStrings(z, x, y) {
  if (!isNonNegInt(z) || !isNonNegInt(x) || !isNonNegInt(y)) {
    throw new Error("z/x/y must be non-negative integers");
  }
  return [String(z), String(x), String(y)];
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

function fileExistsNonEmpty(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function setTileHeaders(res) {
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
}

function sendTileFile(res, absPath) {
  setTileHeaders(res);
  return res.sendFile(absPath);
}

// 1×1 transparent PNG fallback if blank.png missing
const FALLBACK_BLANK_TILE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";

async function ensureBlankTilePresent() {
  if (fileExistsNonEmpty(BLANK_TILE_PATH)) return;
  await ensureDir(path.dirname(BLANK_TILE_PATH));
  await fs.promises.writeFile(
    BLANK_TILE_PATH,
    Buffer.from(FALLBACK_BLANK_TILE_BASE64, "base64")
  );
  console.log(`[INIT] Created fallback blank tile at ${BLANK_TILE_PATH}`);
}

async function writeBlankTile(tilePath, reason = "") {
  await ensureBlankTilePresent();
  await ensureDir(path.dirname(tilePath));
  try {
    await fs.promises.copyFile(BLANK_TILE_PATH, tilePath);
    console.log(`[BLANK-TILE] Wrote transparent tile -> ${tilePath}${reason ? " (" + reason + ")" : ""}`);
  } catch (e) {
    console.error(`[BLANK-TILE] Cache copy failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Fetch/ensure Vector PBF (dedup inflight)
// ─────────────────────────────────────────────────────────────
const inflightPbf = new Map(); // key = "z/x/y"

async function ensureVectorTile(z, x, y) {
  const [zStr, xStr, yStr] = zxysToStrings(z, x, y);
  const pbfPath = path.join(vectorRoot, zStr, xStr, `${yStr}.pbf`);
  const key = `${zStr}/${xStr}/${yStr}`;

  if (fileExistsNonEmpty(pbfPath)) {
    console.log(`[PBF] Exists: ${pbfPath}`);
    return pbfPath;
  }

  if (inflightPbf.has(key)) {
    console.log(`[PBF] Awaiting in-flight download: ${key}`);
    return inflightPbf.get(key);
  }

  const prom = (async () => {
    const url = `${VECTOR_BASE_URL}/${zStr}/${yStr}/${xStr}.pbf`; // …/tile/{z}/{y}/{x}.pbf
    console.log(`[PBF-GET] ${url}`);

    await ensureDir(path.dirname(pbfPath));

    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), PBF_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: ac.signal });
      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      const buf = Buffer.from(await resp.arrayBuffer());

      // zero-byte PBF => treat as "no data"
      if (!buf.length) {
        const err = new Error("PBF empty");
        err.code = "EMPTY_PBF";
        throw err;
      }

      await fs.promises.writeFile(pbfPath, buf);
      console.log(`[PBF] Saved: ${pbfPath} (${buf.length} bytes)`);
      return pbfPath;
    } finally {
      clearTimeout(tm);
    }
  })();

  inflightPbf.set(key, prom);
  try {
    const result = await prom;
    return result;
  } catch (e) {
    console.error(`[PBF-ERR] ${key}: ${e && e.message ? e.message : e}`);
    try {
      if (fs.existsSync(pbfPath) && fs.statSync(pbfPath).size === 0) fs.unlinkSync(pbfPath);
    } catch {}
    throw e;
  } finally {
    inflightPbf.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────
/** Render (dedupe inflight) */
// ─────────────────────────────────────────────────────────────
const inflightRaster = new Map(); // key = "z/x/y"

async function renderSingleTile(z, x, y) {
  const [zStr, xStr, yStr] = zxysToStrings(z, x, y);
  const tilePath = path.join(rasterRoot, zStr, xStr, `${yStr}.png`);
  const key = `${zStr}/${xStr}/${yStr}`;

  if (fileExistsNonEmpty(tilePath)) return tilePath;

  if (inflightRaster.has(key)) {
    console.log(`[RENDER] Awaiting in-flight render: ${key}`);
    return inflightRaster.get(key);
  }

  const prom = new Promise((resolve, reject) => {
    console.log(`[RENDER] Generating tile: ${tilePath}`);
    const nodeBin = process.execPath; // ← use the current Node binary
    const child = spawn(
      nodeBin,
      ["render_worker.js", "-z", zStr, "-x1", xStr, "-x2", xStr, "-y1", yStr, "-y2", yStr],
      {
        cwd: __dirname,
        env: {
          ...process.env,           // carries DISPLAY, DATA_DIR, etc.
          STYLE_PATH,               // ensure the worker sees the editable style
          PATH: `${path.dirname(nodeBin)}:${process.env.PATH || ""}`
        },
        stdio: "pipe"
      }
    );

    child.stdout.on("data", (d) => processStdout.write(`[RENDER-OUT]: ${d}`));
    child.stderr.on("data", (d) => processStdout.write(`[RENDER-ERR]: ${d}`));

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0 && fileExistsNonEmpty(tilePath)) {
        console.log(`[SUCCESS] Rendered: ${tilePath}`);
        resolve(tilePath);
      } else {
        reject(new Error(`render_worker exited ${code}`));
      }
    });
  });

  inflightRaster.set(key, prom);
  try {
    const result = await prom;
    return result;
  } finally {
    inflightRaster.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Serve the active style (baked into the image)
app.get('/style.json', (req, res) => {
  const fs = require('fs');
  const path = require('path');
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

app.use('/fonts', express.static(path.join(__dirname, 'fonts')));

//legacy redirect
app.get('/tiles_raster/:z/:x/:y.png', (req, res) => {
  const { z, x, y } = req.params;
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return res.redirect(308, `/raster/${z}/${x}/${y}.png${qs}`);
});

app.get("/raster/:z/:x/:y.png", async (req, res) => {
  const { z, x, y } = req.params;
  console.log(`[REQ] GET /raster/${z}/${x}/${y}.png`);

  let zStr, xStr, yStr;
  try {
    [zStr, xStr, yStr] = zxysToStrings(z, x, y);
  } catch (e) {
    console.error(`[REQ-ERR] Bad z/x/y: ${e.message}`);
    // Return a blank to keep downloaders happy, even on bad input
    await ensureBlankTilePresent();
    return sendTileFile(res, BLANK_TILE_PATH);
  }

  const tilePath = path.join(rasterRoot, zStr, xStr, `${yStr}.png`);

  // Serve cached raster if present
  if (fileExistsNonEmpty(tilePath)) {
    console.log(`[CACHE] ${tilePath}`);
    return sendTileFile(res, tilePath);
  }

  // Ensure prerequisite vector PBF (or serve blank if empty/fails)
  try {
    await ensureVectorTile(zStr, xStr, yStr);
  } catch (e) {
    const reason = e?.code === "EMPTY_PBF" ? "EMPTY PBF" : `PBF FAIL ${e?.status || ""}`.trim();
    console.log(`[PBF] ${zStr}/${xStr}/${yStr} -> ${reason}; serving blank`);
    if (CACHE_BLANK_TILES) {
      await writeBlankTile(tilePath, reason);
      return sendTileFile(res, tilePath);
    } else {
      await ensureBlankTilePresent();
      return sendTileFile(res, BLANK_TILE_PATH);
    }
  }

  // Render and serve
  try {
    const out = await renderSingleTile(zStr, xStr, yStr);
    return sendTileFile(res, out);
  } catch (e) {
    console.error(`[FAIL] Rendering failed for ${zStr}/${xStr}/${yStr}: ${e.message || e}`);
    // Serve error.png on render errors
    
    return sendTileFile(res, ERROR_TILE_PATH);
  }
});

// Serve vector tiles with download-on-miss: /vector/:z/:x/:y.pbf
app.get("/vector/:z/:x/:y.pbf", async (req, res) => {
  const { z, x, y } = req.params;
  console.log(`[REQ] GET /vector/${z}/${x}/${y}.pbf`);

  let zStr, xStr, yStr;
  try {
    [zStr, xStr, yStr] = zxysToStrings(z, x, y);
  } catch (e) {
    console.error(`[REQ-ERR] Bad z/x/y: ${e.message}`);
    return res.status(400).send('bad z/x/y');
  }

  const pbfPath = path.join(vectorRoot, zStr, xStr, `${yStr}.pbf`);

  // ensure cached (download if missing)
  try {
    await ensureVectorTile(zStr, xStr, yStr);
  } catch (e) {
    const status = e?.code === 'EMPTY_PBF' ? 204 : (e?.status || 502);
    console.error(`[PBF-ERR] ${zStr}/${xStr}/${yStr}: ${e?.message || e}`);
    return res.status(status).end();
  }

  // send from disk with proper headers
  try {
    // peek first 2 bytes for gzip magic 1F 8B
    let first2 = Buffer.alloc(2);
    try {
      const fd = fs.openSync(pbfPath, 'r');
      fs.readSync(fd, first2, 0, 2, 0);
      fs.closeSync(fd);
    } catch {}

    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (first2[0] === 0x1f && first2[1] === 0x8b) {
      res.setHeader('Content-Encoding', 'gzip');
    }
    return res.sendFile(pbfPath);
  } catch (e) {
    console.error(`[PBF-SEND-ERR] ${pbfPath}: ${e.message || e}`);
    return res.status(500).end();
  }
});

// Optional tiny logger for the root
app.use((req, _res, next) => { if (req.path === '/') console.log('[INFO] Serving index.html'); next(); });

// Serve the viewer and assets from /public (handles /, /index.html, /main.js, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// Cleanup helpers
// ─────────────────────────────────────────────────────────────
async function cleanupOldFiles(rootDir, ttlMs, allowedExts, exclusions = new Set()) {
  if (!Number.isFinite(ttlMs)) return 0; // TTL=∞ → do nothing
  const now = Date.now();
  let deleted = 0;
  const stack = [rootDir];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (exclusions.has(p)) continue;

      if (ent.isDirectory()) {
        stack.push(p);
        continue;
      }

      const ext = path.extname(ent.name).toLowerCase();
      if (!allowedExts.has(ext)) continue;

      try {
        const st = await fs.promises.stat(p);
        if (!st.isFile()) continue;

        if (now - st.mtimeMs > ttlMs) {
          await fs.promises.unlink(p);
          deleted++;
          if (CLEANUP_MAX_DELETES > 0 && deleted >= CLEANUP_MAX_DELETES) break;
        }
      } catch (e) {
        console.error(`[CLEANUP] Failed to delete ${p}: ${e.message}`);
      }
    }

    if (CLEANUP_MAX_DELETES > 0 && deleted >= CLEANUP_MAX_DELETES) break;

    // Best-effort: prune empty dirs (but never remove the root itself)
    try {
      const left = await fs.promises.readdir(dir);
      if (left.length === 0 && dir !== rootDir) {
        await fs.promises.rmdir(dir);
      }
    } catch {}
  }

  return deleted;
}

// ─────────────────────────────────────────────────────────────
// Scheduled cleanup (defer overlaps; skip ∞ TTL trees)
// ─────────────────────────────────────────────────────────────
let cleanupTimer = null;
let cleanupRunning = false;
let cleanupPending = false;
const intervalMs = Math.max(1, CLEANUP_INTERVAL_MINUTES) * 60 * 1000;

async function runCleanupOnce(reason = "scheduled") {
  if (!CLEANUP_ENABLED) return;

  // if one is in progress, queue a single follow-up pass
  if (cleanupRunning) {
    cleanupPending = true;
    console.log(`[CLEANUP] Deferred (${reason}); another pass is already running`);
    return;
  }

  cleanupRunning = true;

  const rasterTTL = toMsOrInfinity(RASTER_TTL_HOURS); // 0 → Infinity
  const vectorTTL = toMsOrInfinity(VECTOR_TTL_HOURS); // 0 → Infinity
  const rasterTTLDesc = Number.isFinite(rasterTTL) ? `${RASTER_TTL_HOURS}h` : "∞";
  const vectorTTLDesc = Number.isFinite(vectorTTL) ? `${VECTOR_TTL_HOURS}h` : "∞";

  const start = Date.now();
  console.log(`[CLEANUP] Start (${reason})  raster TTL=${rasterTTLDesc}, vector TTL=${vectorTTLDesc}`);

  const exclusions = new Set([BLANK_TILE_PATH]);

  try {
    let delRaster = 0, delVector = 0;

    if (Number.isFinite(rasterTTL)) {
      delRaster = await cleanupOldFiles(rasterRoot, rasterTTL, new Set([".png"]), exclusions);
    } else {
      console.log("[CLEANUP] Skipping raster tree (TTL=∞)");
    }

    if (Number.isFinite(vectorTTL)) {
      delVector = await cleanupOldFiles(vectorRoot, vectorTTL, new Set([".pbf"]), exclusions);
    } else {
      console.log("[CLEANUP] Skipping vector tree (TTL=∞)");
    }

    console.log(`[CLEANUP] Done in ${Date.now() - start} ms  deleted: raster=${delRaster}, vector=${delVector}`);
  } catch (e) {
    console.error(`[CLEANUP] Error: ${e.message || e}`);
  } finally {
    cleanupRunning = false;

    // if a pass was requested while we worked, run again immediately once
    if (cleanupPending) {
      cleanupPending = false;
      setImmediate(() => runCleanupOnce("pending"));
      return;
    }

    // otherwise schedule the next pass relative to completion time
    cleanupTimer = setTimeout(() => runCleanupOnce("timer"), intervalMs);
    cleanupTimer.unref?.();
    console.log(`[CLEANUP] Next pass in ${Math.round(intervalMs / 60000)} min`);
  }
}

function scheduleCleanup() {
  if (!CLEANUP_ENABLED) {
    console.log("[CLEANUP] Disabled");
    return;
  }
  console.log(`[CLEANUP] Scheduled every ${CLEANUP_INTERVAL_MINUTES} min`);
  // kick an initial pass; subsequent runs self-schedule
  cleanupTimer = setTimeout(() => runCleanupOnce("initial"), 5000);
  cleanupTimer.unref?.();
}

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