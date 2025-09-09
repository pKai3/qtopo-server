// lib/config.js
const path = require("path");

function stripQuotes(s) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const ROOT       = path.resolve(__dirname, "..");
const DATA_DIR   = stripQuotes(process.env.DATA_DIR)   || "/data";
const RASTER_DIR = stripQuotes(process.env.RASTER_DIR) || path.join(DATA_DIR, "raster");
const VECTOR_DIR = stripQuotes(process.env.VECTOR_DIR) || path.join(DATA_DIR, "vector");
const STYLE_DIR  = stripQuotes(process.env.STYLE_DIR)  || path.join(DATA_DIR, "styles");

// Style path: if env provides a relative path, resolve from CWD; else default to /data/styles/style.json
let STYLE_PATH = stripQuotes(process.env.STYLE_PATH);
if (!STYLE_PATH) {
  STYLE_PATH = path.join(STYLE_DIR, "style.json");
} else if (!path.isAbsolute(STYLE_PATH)) {
  STYLE_PATH = path.resolve(process.cwd(), STYLE_PATH);
}

const FONT_DIR = stripQuotes(process.env.FONT_DIR) || path.join(ROOT, "assets", "fonts");

// TTL knobs (0 means ∞ / disabled)
function ttlHoursFromEnv(name, def) {
  const raw = stripQuotes(process.env[name]);
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  if (n <= 0) return Infinity;
  return n;
}
const RASTER_TTL_HOURS = ttlHoursFromEnv("RASTER_TTL_HOURS", 72);
const VECTOR_TTL_HOURS = ttlHoursFromEnv("VECTOR_TTL_HOURS", Infinity);

// Make these visible to child processes (render_worker)
process.env.DATA_DIR   = DATA_DIR;
process.env.RASTER_DIR = RASTER_DIR;
process.env.VECTOR_DIR = VECTOR_DIR;
process.env.STYLE_DIR  = STYLE_DIR;
process.env.STYLE_PATH = STYLE_PATH;
process.env.FONT_DIR   = FONT_DIR;

module.exports = {
  ROOT,
  DATA_DIR, RASTER_DIR, VECTOR_DIR,
  STYLE_DIR, STYLE_PATH,
  FONT_DIR,
  RASTER_TTL_HOURS, VECTOR_TTL_HOURS,
  stripQuotes,
};