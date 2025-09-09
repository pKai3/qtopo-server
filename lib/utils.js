// lib/utils.js
const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileExistsNonEmpty(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

function setTileHeaders(res) {
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
}

function sendTileFile(res, filePath) {
  setTileHeaders(res);
  fs.createReadStream(filePath).pipe(res);
}

const BLANK_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/YYbL4QAAAAASUVORK5CYII=";

function ensureBlankTilePresent(blankPath, L) {
  try {
    if (!fileExistsNonEmpty(blankPath)) {
      ensureDir(path.dirname(blankPath));
      fs.writeFileSync(blankPath, Buffer.from(BLANK_1X1_BASE64, "base64"));
      L?.log?.("INIT", `Created fallback blank tile at ${blankPath}`);
    }
  } catch (e) {
    L?.err?.("INIT", `Failed to ensure blank tile: ${e.message}`);
  }
}

function writeBlankTile(outPath, blankPath) {
  ensureDir(path.dirname(outPath));
  fs.copyFileSync(blankPath, outPath);
  return outPath;
}

module.exports = {
  ensureDir,
  fileExistsNonEmpty,
  setTileHeaders,
  sendTileFile,
  ensureBlankTilePresent,
  writeBlankTile,
};