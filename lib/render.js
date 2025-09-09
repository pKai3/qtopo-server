// lib/render.js
const path = require("path");
const { spawn } = require("child_process");
const { fileExistsNonEmpty, ensureDir } = require("./utils");

// in-flight dedupe
const inflight = new Map();

/**
 * Render a single PNG tile via child worker.
 * Returns the output file path on success, throws on failure.
 */
function renderSingleTile(z, x, y, {
  rasterDir,
  STYLE_PATH,
  FONT_DIR,
  nodeBin = process.execPath,
  L,
}) {
  const key = `${z}/${x}/${y}`;
  if (inflight.has(key)) return inflight.get(key);

  const p = new Promise((resolve, reject) => {
    const outDir = path.join(rasterDir, String(z), String(x));
    const outPath = path.join(outDir, `${y}.png`);
    ensureDir(outDir);

    const workerPath = path.join(__dirname, "render_worker.js");
    const args = [workerPath, "-z", String(z), "-x1", String(x), "-x2", String(x), "-y1", String(y), "-y2", String(y)];

    L?.log?.("RDR", `spawn worker: ${nodeBin} ${args.join(" ")}`);

    const child = spawn(nodeBin, args, {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        STYLE_PATH,
        FONT_DIR,
        PATH: `${path.dirname(nodeBin)}:${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d) => {
      const line = String(d).trimEnd();
      if (line) L?.log?.("RDR-W", line);
    });
    child.stderr.on("data", (d) => {
      const line = String(d).trimEnd();
      if (line) L?.err?.("RDR-W", line);
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0 && fileExistsNonEmpty(outPath)) {
        resolve(outPath);
      } else {
        reject(new Error(`render_worker exited ${code}`));
      }
    });
  }).finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

module.exports = { renderSingleTile };