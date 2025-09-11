// lib/cleaner.js
const fs   = require("fs");
const path = require("path");
const L    = require("./logger");
const {
  RASTER_TTL_HOURS, VECTOR_TTL_HOURS,
  RASTER_DIR, VECTOR_DIR,
} = require("./config");

// serialize runs even if multiple callers schedule
let cleanupRunning = false;

function fileIsOld(full, ttlHours) {
  try {
    if (!Number.isFinite(ttlHours)) return false; // Infinity => skip
    const st = fs.statSync(full);
    if (!st.isFile()) return false;
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs > ttlHours * 3600 * 1000;
  } catch { return false; }
}

function pruneEmptyDirs(root) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(root, e.name);
      if (e.isDirectory()) {
        pruneEmptyDirs(p);
        try {
          if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
        } catch {}
      }
    }
  } catch {}
}

async function runCleanupOnce(trigger = "manual") {
  if (cleanupRunning) return;
  cleanupRunning = true;
  const t0 = Date.now();
  try {
    const deleted = { raster: 0, vector: 0 };

    // Raster tree
    if (Number.isFinite(RASTER_TTL_HOURS)) {
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          const st = fs.statSync(p);
          if (st.isDirectory()) walk(p);
          else if (fileIsOld(p, RASTER_TTL_HOURS)) {
            try { fs.unlinkSync(p); deleted.raster++; } catch {}
          }
        }
      };
      try { walk(RASTER_DIR); pruneEmptyDirs(RASTER_DIR); } catch {}
    }

    // Vector tree (skip if ∞)
    if (Number.isFinite(VECTOR_TTL_HOURS)) {
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          const st = fs.statSync(p);
          if (st.isDirectory()) walk(p);
          else if (fileIsOld(p, VECTOR_TTL_HOURS)) {
            try { fs.unlinkSync(p); deleted.vector++; } catch {}
          }
        }
      };
      try { walk(VECTOR_DIR); pruneEmptyDirs(VECTOR_DIR); } catch {}
    }

    const dt = Date.now() - t0;
    L.log("CLEANUP", `Done in ${dt} ms  deleted: raster=${deleted.raster}, vector=${deleted.vector}`);
  } catch (e) {
    L.err("CLEANUP", e.stack || e.message);
  } finally {
    cleanupRunning = false;
  }
}

module.exports = { runCleanupOnce };