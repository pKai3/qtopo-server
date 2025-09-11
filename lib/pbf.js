// lib/pbf.js
const fs = require("fs");
const path = require("path");
const { ensureDir, fileExistsNonEmpty } = require("./utils");

// in-flight dedupe
const inflight = new Map();

/**
 * Ensure a vector tile exists on disk; download if missing.
 * @returns {Promise<{status:'ok'|'empty', path:string, fromCache?:boolean}>}
 */
async function ensureVectorTile(z, x, y, {
  vectorDir,
  upstreamUrlBuilder,
  timeoutMs = 15000,
  L, // logger (optional)
}) {
  const key = `${z}/${x}/${y}`;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const file = path.join(vectorDir, String(z), String(x), `${y}.pbf`);
    ensureDir(path.dirname(file));

    if (fileExistsNonEmpty(file)) {
      return { status: "ok", path: file, fromCache: true };
    }

    const url = upstreamUrlBuilder(z, x, y);
    L?.log?.("PBF-GET", `/${z}/${x}/${y}/ ${url}`);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        if (res.status === 404 || res.status === 204) {
          L?.warn?.("PBF", `${z}/${x}/${y}: upstream ${res.status}; treating as empty`);
          return { status: "empty", path: file };
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) {
        const e = new Error("PBF Empty"); e.code = "EMPTY_PBF";
        throw e;
      }
      fs.writeFileSync(file, buf);
      return { status: "ok", path: file, fromCache: false };
    } catch (err) {
      if (err.name === "AbortError") {
        L?.err?.("PBF-ERR", `${z}/${x}/${y}: timeout after ${timeoutMs}ms`);
        throw err;
      }
      if (err.code === "EMPTY_PBF") {
        L?.warn?.("PBF", `${z}/${x}/${y}: empty from upstream; serving blank`);
        return { status: "empty", path: file };
      }
      L?.err?.("PBF-ERR", `${z}/${x}/${y}: ${err.message}`);
      throw err;
    } finally {
      clearTimeout(t);
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

module.exports = { ensureVectorTile };