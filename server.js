#!/usr/bin/env node
const util = require("util");
const processStdout = process.stdout;
console.log = (...a) => processStdout.write(util.format(...a) + "\n");
console.error = (...a) => processStdout.write("[ERR] " + util.format(...a) + "\n");

const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

// Single-mount data roots
const DATA_DIR   = process.env.DATA_DIR   || "/data";
const VECTOR_DIR = process.env.VECTOR_DIR || path.join(DATA_DIR, "vector");
const RASTER_DIR = process.env.RASTER_DIR || path.join(DATA_DIR, "raster");

// Style resolution:
//  - prefer STYLE_PATH (set by start.sh to /data/styles/style.json)
//  - fall back to image default /usr/src/app/styles/style.json
const STYLE_PATH = process.env.STYLE_PATH || path.join(__dirname, "styles", "style.json");

// Remote vector source
const VECTOR_BASE_URL =
  process.env.VECTOR_BASE_URL ||
  "https://spatial.information.qld.gov.au/arcgis/rest/services/Hosted/Basemaps_QldBase_Topographic/VectorTileServer/tile";

const PBF_FETCH_TIMEOUT_MS = Number(process.env.PBF_FETCH_TIMEOUT_MS || 10000);

// Blank PNG config
const BLANK_TILE_PATH = process.env.BLANK_TILE_PATH || path.join(__dirname, "blank.png");
const CACHE_BLANK_TILES = process.env.CACHE_BLANK_TILES !== "0";

// Cleanup config
const CLEANUP_ENABLED = process.env.CLEANUP_ENABLED !== "0";
const CLEANUP_INTERVAL_MINUTES = Number(process.env.CLEANUP_INTERVAL_MINUTES || 15);
const RASTER_TTL_HOURS = Number(process.env.RASTER_TTL_HOURS || 1);
const VECTOR_TTL_HOURS = Number(process.env.VECTOR_TTL_HOURS || 0);
const CLEANUP_MAX_DELETES = Number(process.env.CLEANUP_MAX_DELETES || 0);
const toMsOrInfinity = (h) => (h > 0 ? h * 3600 * 1000 : Infinity);

// Utils
const isNonNegInt = (v) => /^\d+$/.test(String(v));
function zxysToStrings(z, x, y) {
  if (!isNonNegInt(z) || !isNonNegInt(x) || !isNonNegInt(y)) throw new Error("bad z/x/y");
  return [String(z), String(x), String(y)];
}
async function ensureDir(p) { await fs.promises.mkdir(p, { recursive: true }); }
function existsNonEmpty(p) { try { const s=fs.statSync(p); return s.isFile() && s.size>0; } catch { return false; } }
function setTileHeaders(res) { res.setHeader("Cache-Control","public, max-age=31536000, immutable"); }
function sendTile(res, abs) { setTileHeaders(res); return res.sendFile(abs); }
const FALLBACK_BLANK_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
async function ensureBlankTilePresent(){
  if (existsNonEmpty(BLANK_TILE_PATH)) return;
  await ensureDir(path.dirname(BLANK_TILE_PATH));
  await fs.promises.writeFile(BLANK_TILE_PATH, Buffer.from(FALLBACK_BLANK_PNG_B64,"base64"));
  console.log(`[INIT] created fallback blank tile at ${BLANK_TILE_PATH}`);
}
async function writeBlankTile(outPath, reason=""){
  await ensureBlankTilePresent();
  await ensureDir(path.dirname(outPath));
  try { await fs.promises.copyFile(BLANK_TILE_PATH, outPath);
    console.log(`[BLANK-TILE] ${outPath}${reason?` (${reason})`:""}`);
  } catch(e){ console.error(`[BLANK-TILE] copy failed: ${e.message}`); }
}

// Vector ensure (dedupe)
const inflightPbf = new Map();
async function ensureVectorTile(z, x, y){
  const [zStr,xStr,yStr] = zxysToStrings(z,x,y);
  const pbfPath = path.join(VECTOR_DIR, zStr, xStr, `${yStr}.pbf`);
  const key = `${zStr}/${xStr}/${yStr}`;
  if (existsNonEmpty(pbfPath)) return pbfPath;
  if (inflightPbf.has(key)) return inflightPbf.get(key);

  const prom = (async ()=>{
    const url = `${VECTOR_BASE_URL}/${zStr}/${yStr}/${xStr}.pbf`;
    console.log(`[PBF-GET] ${url}`);
    await ensureDir(path.dirname(pbfPath));
    const ac = new AbortController(); const tm = setTimeout(()=>ac.abort(), PBF_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: ac.signal });
      if (!resp.ok) { const e = new Error(`HTTP ${resp.status}`); e.status = resp.status; throw e; }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length){ const e = new Error("PBF empty"); e.code="EMPTY_PBF"; throw e; }
      await fs.promises.writeFile(pbfPath, buf);
      console.log(`[PBF] Saved: ${pbfPath} (${buf.length} bytes)`);
      return pbfPath;
    } finally { clearTimeout(tm); }
  })();

  inflightPbf.set(key, prom);
  try { return await prom; }
  catch(e){ console.error(`[PBF-ERR] ${key}: ${e?.message||e}`); try{ if(fs.existsSync(pbfPath)&&fs.statSync(pbfPath).size===0) fs.unlinkSync(pbfPath);}catch{} throw e; }
  finally { inflightPbf.delete(key); }
}

// Render (dedupe)
const inflightRaster = new Map();
async function renderTile(z,x,y){
  const [zStr,xStr,yStr] = zxysToStrings(z,x,y);
  const tilePath = path.join(RASTER_DIR, zStr, xStr, `${yStr}.png`);
  const key = `${zStr}/${xStr}/${yStr}`;

  if (existsNonEmpty(tilePath)) return tilePath;
  if (inflightRaster.has(key)) return inflightRaster.get(key);

  const nodeBin = process.execPath;
  const env = { ...process.env, PATH: `${path.dirname(nodeBin)}:${process.env.PATH||""}`,
                DATA_DIR: DATA_DIR, VECTOR_DIR: VECTOR_DIR, RASTER_DIR: RASTER_DIR, STYLE_PATH: STYLE_PATH };

  const prom = new Promise((resolve, reject)=>{
    console.log(`[RENDER] Generating tile: ${tilePath}`);
    const child = spawn(
      nodeBin,
      ["render_worker.js", "-z", zStr, "-x1", xStr, "-x2", xStr, "-y1", yStr, "-y2", yStr, "-o", tilePath, "-s", STYLE_PATH],
      { cwd: __dirname, env }
    );
    child.stdout.on("data", d => processStdout.write(`[RENDER-OUT]: ${d}`));
    child.stderr.on("data", d => processStdout.write(`[RENDER-ERR]: ${d}`));
    child.on("error", reject);
    child.on("close", (code)=>{
      if (code===0 && existsNonEmpty(tilePath)) resolve(tilePath);
      else reject(new Error(`render_worker exited ${code}`));
    });
  });

  inflightRaster.set(key, prom);
  try { return await prom; }
  finally { inflightRaster.delete(key); }
}

// Routes
app.get("/healthz", (_req,res)=>res.status(200).send("ok"));

// Serve vector tiles at: /:z/:x/:y.pbf  (clean root path)
app.get("/vector/:z/:x/:y.pbf", async (req, res, next) => {
  const { z, x, y } = req.params;
  // only digits → otherwise let other routes handle it
  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) return next();

  try {
    const pbfPath = await ensureVectorTile(z, x, y); // your existing fetch+cache
    res.setHeader("Content-Type", "application/x-protobuf");
    // If the file is gzipped, tell the browser
    try {
      const fd = fs.openSync(pbfPath, "r");
      const sig = Buffer.alloc(2);
      fs.readSync(fd, sig, 0, 2, 0);
      fs.closeSync(fd);
      if (sig[0] === 0x1f && sig[1] === 0x8b) res.setHeader("Content-Encoding", "gzip");
    } catch {}
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(pbfPath);
  } catch (e) {
    console.error(`[VT] ${z}/${x}/${y} failed: ${e.message || e}`);
    // no-content lets GL skip quietly
    return res.status(204).end();
  }
});

//redirect for legacy raster URL
app.get("/tiles_raster/:z/:x/:y.png", (req,res) => { 
  const { z,x,y } = req.params;
  res.redirect(301, `/raster/${z}/${x}/${y}.png`);
});

app.get("/raster/:z/:x/:y.png", async (req, res, next) => {
  const { z,x,y } = req.params;
  console.log(`[REQ] GET PNG /${z}/${x}/${y}.png`);
  let zStr,xStr,yStr; try { [zStr,xStr,yStr] = zxysToStrings(z,x,y); }
  catch { await ensureBlankTilePresent(); return sendTile(res, BLANK_TILE_PATH); }

  const outPath = path.join(RASTER_DIR, zStr, xStr, `${yStr}.png`);
  if (existsNonEmpty(outPath)) return sendTile(res, outPath);

  try { await ensureVectorTile(zStr,xStr,yStr); }
  catch (e){
    const why = e?.code==="EMPTY_PBF" ? "EMPTY PBF" : `PBF FAIL ${e?.status||""}`.trim();
    console.log(`[PBF] ${zStr}/${xStr}/${yStr} -> ${why}; serving blank`);
    if (CACHE_BLANK_TILES) { await writeBlankTile(outPath, why); return sendTile(res, outPath); }
    await ensureBlankTilePresent(); return sendTile(res, BLANK_TILE_PATH);
  }

  try { const out = await renderTile(zStr,xStr,yStr); return sendTile(res, out); }
  catch (e){
    console.error(`[FAIL] Rendering failed for ${zStr}/${xStr}/${yStr}: ${e.message||e}`);
    if (CACHE_BLANK_TILES) { await writeBlankTile(outPath, "RENDER ERR"); return sendTile(res, outPath); }
    await ensureBlankTilePresent(); return sendTile(res, BLANK_TILE_PATH);
  }
});

app.get("/", (_req,res)=>{
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.type("text/plain").send("OK");
});

// Cleanup
async function cleanupOld(rootDir, ttlMs, exts){
  if (!Number.isFinite(ttlMs)) return 0;
  const now=Date.now(); let del=0; const stack=[rootDir];
  while (stack.length){
    const dir=stack.pop(); let ents; try{ ents=await fs.promises.readdir(dir,{withFileTypes:true}); }catch{ continue; }
    for(const ent of ents){
      const p=path.join(dir, ent.name);
      if (ent.isDirectory()){ stack.push(p); continue; }
      if (!exts.has(path.extname(ent.name).toLowerCase())) continue;
      try { const st=await fs.promises.stat(p);
        if (st.isFile() && (now - st.mtimeMs) > ttlMs){ await fs.promises.unlink(p); del++; if (CLEANUP_MAX_DELETES>0 && del>=CLEANUP_MAX_DELETES) break; }
      } catch(e){ console.error(`[CLEANUP] delete fail ${p}: ${e.message}`); }
    }
    if (CLEANUP_MAX_DELETES>0 && del>=CLEANUP_MAX_DELETES) break;
  }
  return del;
}
let cleanupTimer=null, cleanupRunning=false, cleanupPending=false;
const intervalMs = Math.max(1, CLEANUP_INTERVAL_MINUTES)*60*1000;
async function runCleanupOnce(reason="scheduled"){
  if (!CLEANUP_ENABLED) return;
  if (cleanupRunning){ cleanupPending=true; console.log(`[CLEANUP] Deferred (${reason})`); return; }
  cleanupRunning=true;
  const rTTL=toMsOrInfinity(RASTER_TTL_HOURS), vTTL=toMsOrInfinity(VECTOR_TTL_HOURS);
  const rDesc=Number.isFinite(rTTL)?`${RASTER_TTL_HOURS}h`:"∞", vDesc=Number.isFinite(vTTL)?`${VECTOR_TTL_HOURS}h`:"∞";
  console.log(`[CLEANUP] Start (${reason})  raster TTL=${rDesc}, vector TTL=${vDesc}`);
  const t0=Date.now();
  try{
    let dr=0,dv=0;
    if (Number.isFinite(rTTL)) dr=await cleanupOld(RASTER_DIR, rTTL, new Set([".png"])); else console.log("[CLEANUP] Skipping raster tree (TTL=∞)");
    if (Number.isFinite(vTTL)) dv=await cleanupOld(VECTOR_DIR, vTTL, new Set([".pbf"])); else console.log("[CLEANUP] Skipping vector tree (TTL=∞)");
    console.log(`[CLEANUP] Done in ${Date.now()-t0} ms  deleted: raster=${dr}, vector=${dv}`);
  } catch(e){ console.error(`[CLEANUP] Error: ${e.message||e}`); }
  finally{
    cleanupRunning=false;
    if (cleanupPending){ cleanupPending=false; setImmediate(()=>runCleanupOnce("pending")); return; }
    cleanupTimer=setTimeout(()=>runCleanupOnce("timer"), intervalMs); cleanupTimer.unref?.();
    console.log(`[CLEANUP] Next pass in ${Math.round(intervalMs/60000)} min`);
  }
}
(function scheduleCleanup(){
  if (!CLEANUP_ENABLED){ console.log("[CLEANUP] Disabled"); return; }
  console.log(`[CLEANUP] Scheduled every ${CLEANUP_INTERVAL_MINUTES} min`);
  cleanupTimer=setTimeout(()=>runCleanupOnce("initial"), 5000); cleanupTimer.unref?.();
})();
process.on("SIGTERM", ()=>{ if (cleanupTimer) clearTimeout(cleanupTimer); });
process.on("SIGINT",  ()=>{ if (cleanupTimer) clearTimeout(cleanupTimer); });

app.listen(PORT, HOST, ()=> {
  console.log(`[INIT] VECTOR_DIR=${VECTOR_DIR}`);
  console.log(`[INIT] RASTER_DIR=${RASTER_DIR}`);
  console.log(`[INIT] STYLE_PATH=${STYLE_PATH}`);
  console.log(`Tile server running on http://${HOST}:${PORT}`);
});