#!/usr/bin/env node
// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");

// ── Logging (UTC, colored) ─────────────────────────────────────────────────────
const L = require("./lib/logger");

// ── Config (paths, TTLs, env export for worker) ────────────────────────────────
const {
  DATA_DIR, RASTER_DIR, VECTOR_DIR,
  STYLE_DIR, STYLE_PATH,
  FONT_DIR,
  RASTER_TTL_HOURS, VECTOR_TTL_HOURS
} = require("./lib/config");

// ── Utilities (dirs, tiles, blank) ─────────────────────────────────────────────
const {
  ensureDir,
  fileExistsNonEmpty,
  setTileHeaders,
  sendTileFile,
  ensureBlankTilePresent,
  writeBlankTile,
} = require("./lib/utils");

const { runCleanupOnce } = require("./lib/cleaner");

// ── PBF ensure + Render (worker spawn wrapper) ─────────────────────────────────
const { ensureVectorTile } = require("./lib/pbf");
const { renderSingleTile } = require("./lib/render");

// ── Constants ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8080);
const app = express();

// Fallback blank (1x1 transparent), ensure it exists
const BLANK_TILE_PATH = process.env.BLANK_TILE_PATH || path.join(__dirname, "assets", "images", "blank.png");
ensureBlankTilePresent(BLANK_TILE_PATH, L);

// Ensure data dirs exist
ensureDir(VECTOR_DIR);
ensureDir(RASTER_DIR);
ensureDir(STYLE_DIR);

// after ensureDir(VECTOR_DIR/RASTER_DIR/STYLE_DIR) in server.js
const BAKED_STYLE = path.join(__dirname, "styles", "style.json");
try {
  if (!fs.existsSync(STYLE_PATH)) {
    if (!fs.existsSync(BAKED_STYLE)) {
      L.err("SEED", `baked style missing at ${BAKED_STYLE}`);
      process.exit(1);
    }
    fs.copyFileSync(BAKED_STYLE, STYLE_PATH);
    L.warn("SEED", `missing style; seeded editable at ${STYLE_PATH}`);
  }
} catch (e) {
  L.err("SEED", `style seeding failed: ${e.message}`);
  process.exit(1);
}

// ── Upstream vector-tile URL builder (QLD) ─────────────────────────────────────
// NOTE: QLD endpoint expects Z / Y / X order for vector tiles
function qldUpstream(z, x, y) {
  return `https://spatial.information.qld.gov.au/arcgis/rest/services/Hosted/Basemaps_QldBase_Topographic/VectorTileServer/tile/${z}/${y}/${x}.pbf`;
}

// ── Middleware: basic request log (compact) ────────────────────────────────────
app.use((req, _res, next) => {
  // Express's req.ip respects proxy headers if trust proxy is set; here we keep raw-ish
  L.log("REQ", `${req.method} ${req.url} from ${req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?"}`);
  next();
});

// ── Fonts: serve from current FONT_DIR ─────────────────────────────────────────
app.use("/fonts", express.static(FONT_DIR));

// ── Style: serve editable style, make glyphs/tiles absolute to this origin ─────
app.get("/style.json", (_req, res) => {
  try {
    const origin = `${res.req.protocol}://${res.req.get("host")}`;
    const ensureAbs = (u) => /^https?:\/\//i.test(u) ? u : origin + (u.startsWith("/") ? u : `/${u}`);

    const raw = fs.readFileSync(STYLE_PATH, "utf8");
    const style = JSON.parse(raw);

    // glyphs (default to /fonts/... if missing)
    style.glyphs = ensureAbs(style.glyphs || "/fonts/{fontstack}/{range}.pbf");

    // sources.tiles → absolute
    if (style.sources) {
      for (const src of Object.values(style.sources)) {
        if (Array.isArray(src.tiles)) {
          src.tiles = src.tiles.map(ensureAbs);
        }
      }
    }

    res.type("application/json; charset=utf-8").send(style);
  } catch (e) {
    L.err("SYS", `style.json error: ${e.message}`);
    res.status(500).send("style error");
  }
});

// ── Vector tile route: GET /vector/:z/:x/:y.pbf  (download-on-miss)
app.get("/vector/:z/:x/:y.pbf", async (req, res) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  try {
    const r = await ensureVectorTile(z, x, y, {
      vectorDir: VECTOR_DIR,
      upstreamUrlBuilder: qldUpstream,
      L,
    });

    if (r.status === "empty") {
      return res.status(204).end();
    }

    res.setHeader("Content-Type", "application/x-protobuf");
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
    fs.createReadStream(r.path).pipe(res);
  } catch (err) {
    L.err("PBF-ERR", `${z}/${x}/${y}: ${err.message}`);
    res.status(502).send("upstream error");
  }
});

// ── Raster route: GET /raster/:z/:x/:y.png  (cache-or-render)
app.get("/raster/:z/:x/:y.png", async (req, res) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  const outDir  = path.join(RASTER_DIR, String(z), String(x));
  const outPath = path.join(outDir, `${y}.png`);

  try {
    if (fileExistsNonEmpty(outPath)) {
      setTileHeaders(res);
      return fs.createReadStream(outPath).pipe(res);
    }

    const pbf = await ensureVectorTile(z, x, y, {
      vectorDir: VECTOR_DIR,
      upstreamUrlBuilder: qldUpstream,
      L,
    });

    if (pbf.status === "empty") {
      writeBlankTile(outPath, BLANK_TILE_PATH);
      setTileHeaders(res);
      return fs.createReadStream(outPath).pipe(res);
    }

    const renderedPath = await renderSingleTile(z, x, y, {
      rasterDir: RASTER_DIR,
      STYLE_PATH,
      FONT_DIR,
      L,
    });

    setTileHeaders(res);
    fs.createReadStream(renderedPath).pipe(res);
  } catch (err) {
    L.err("RDR", `fail ${z}/${x}/${y}: ${err.message}`);
    try {
      writeBlankTile(outPath, BLANK_TILE_PATH);
      setTileHeaders(res);
      fs.createReadStream(outPath).pipe(res);
    } catch {
      res.status(500).send("render failed");
    }
  }
});

// ── Legacy redirects (compat)
app.get("/tiles_raster/:z/:x/:y.png", (req, res) => {
  const { z, x, y } = req.params;
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, `/raster/${z}/${x}/${y}.png${qs}`);
});
app.get("/tiles_vector/:z/:x/:y.pbf", (req, res) => {
  const { z, x, y } = req.params;
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, `/vector/${z}/${x}/${y}.pbf${qs}`);
});

// ── Static: viewers & assets ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public"))); // / → vector viewer
app.get("/raster", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index_raster.html"));
});

// Health
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));


// Run Cleanup
function scheduleCleanup() {
  L.log("CLEANUP", "Scheduled every 15 min");
  setInterval(() => {
    // swallow errors to avoid unhandled rejection noise
    Promise.resolve(runCleanupOnce("scheduled")).catch(() => {});
  }, 15 * 60 * 1000);

  // kick once shortly after boot
  setTimeout(() => {
    Promise.resolve(runCleanupOnce("initial")).catch(() => {});
  }, 1000);
}

scheduleCleanup();
// ── Start server ───────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  L.sys(`Tile server running on http://0.0.0.0:${PORT}`);
  L.log("INIT", `VECTOR_DIR=${VECTOR_DIR}`);
  L.log("INIT", `RASTER_DIR=${RASTER_DIR}`);
  L.log("INIT", `STYLE_DIR=${STYLE_DIR}`);
  L.log("INIT", `STYLE_PATH=${STYLE_PATH}`);
});