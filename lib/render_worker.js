#!/usr/bin/env node
const { createCanvas, loadImage } = require('canvas');
const fs = require('node:fs/promises');
const { atomicWrite } = require('./utils');
const { metatileLayout, copyTilePixels } = require('./metatile');
const { encodePng } = require('./png');

let retained;
function releaseMap() {
  if (!retained) return;
  for (const controller of retained.context?.controllers || []) controller.abort();
  retained.map.release(); retained = null;
}
async function renderVector(job) {
  const layout = job.layout || metatileLayout(job, { metatileSize: 1, renderBufferPx: 0 });
  const key = JSON.stringify([job.origin, job.size, layout.mode, job.styleKey || job.style]);
  if (retained && (retained.key !== key || Date.now() >= retained.expires)) releaseMap();
  const context = { controllers: new Set(), error: null, waitingSince: 0, waitMs: 0, priority: job.priority ?? 0 };
  if (!retained) {
    const mbgl = require('@maplibre/maplibre-gl-native');
    const state = { key, context, expires: Date.now() + job.resourceMaxAgeMs };
    state.map = new mbgl.Map({
      mode: layout.mode, ratio: job.size / 512,
      request(req, callback) {
        const current = state.context;
        let url;
        try { url = new URL(req.url); }
        catch { return callback(new Error('Invalid resource URL')); }
        if (url.origin !== job.origin) return callback(new Error('Renderer resources must be served by this server'));
        const controller = new AbortController();
        if (!current.controllers.size) current.waitingSince = performance.now();
        current.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), job.timeoutMs);
        fetch(url, { signal: controller.signal, headers: { 'X-QTopo-Priority': String(current.priority) } }).then(async res => {
          if (res.status === 204) return callback(null, {});
          if (!res.ok) throw new Error(`Resource HTTP ${res.status}: ${url.pathname}`);
          callback(null, { data: Buffer.from(await res.arrayBuffer()), expires: new Date(state.expires) });
        }).catch(err => { current.error = err; callback(err); })
          .finally(() => {
            clearTimeout(timer); current.controllers.delete(controller);
            if (!current.controllers.size) current.waitMs += performance.now() - current.waitingSince;
          });
      },
    });
    retained = state;
    try { state.map.load(job.style); } catch (err) { releaseMap(); throw err; }
  }
  retained.context = context;
  try {
    // Preserve scale: expand the viewport, not the map's zoom. The fixed grid
    // gives every quadrant the same label placement, regardless of request order.
    const pixels = await new Promise((resolve, reject) => retained.map.render({
      zoom: job.z, center: layout.center, width: layout.width, height: layout.height, bearing: 0, pitch: 0,
    }, (err, data) => err ? reject(err) : resolve(data)));
    if (context.error) throw context.error;
    const resourceWaitMs = currentWait(context);
    return { pixels, resourceWaitMs, layout };
  } catch (err) { releaseMap(); throw err; }
  finally { for (const controller of context.controllers) controller.abort(); }
}
function currentWait(context) {
  return Math.round(context.waitMs + (context.controllers.size ? performance.now() - context.waitingSince : 0));
}

async function saveTile(canvas, ctx, outPath, compression, vector = false) {
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let empty = true;
  for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]) { empty = false; break; } }
  if (empty) await atomicWrite(outPath + '.empty', '1');
  const encodeStarted = performance.now();
  const png = encodePng(canvas, compression ?? 3, vector);
  const encodeMs = Math.round(performance.now() - encodeStarted);
  await atomicWrite(outPath, png);
  if (!empty) await fs.rm(outPath + '.empty', { force: true });
  if (process.connected) process.send({ tileReady: outPath });
  return encodeMs;
}
function previewTile(job, canvas, outPath) {
  if (!job.preview) return;
  job.preview = false;
  try {
    const thumbnail = createCanvas(160, 160), ctx = thumbnail.getContext('2d');
    ctx.fillStyle = '#f2eedf'; ctx.fillRect(0, 0, 160, 160);
    ctx.drawImage(canvas, 0, 0, 160, 160);
    const image = thumbnail.toBuffer('image/jpeg', { quality: 0.65 });
    if (image.length <= 32768 && process.connected) process.send({ preview: { outPath, image: image.toString('base64') } });
  } catch (error) { console.error('Tile preview skipped: ' + error.message); }
}
async function run(job) {
  const cpuStart = process.cpuUsage();
  let resourceWaitMs = 0, encodeMs = 0;
  const size = job.size;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (job.kind === 'composite') {
    if (job.backgroundPath) ctx.drawImage(await loadImage(job.backgroundPath), 0, 0, size, size);
    ctx.save();
    if (job.clip) {
      ctx.beginPath();
      for (const ring of job.clip) {
        ring.forEach(([x, y], i) => i ? ctx.lineTo(x * size, y * size) : ctx.moveTo(x * size, y * size));
        ctx.closePath();
      }
      ctx.clip('evenodd');
      // Replace QLD pixels only inside NSW, including transparent water pixels.
      ctx.clearRect(0, 0, size, size);
    }
    for (const image of job.images) if (image.path) ctx.drawImage(await loadImage(image.path), ...image.source, ...image.destination);
    ctx.restore();
  } else if (job.kind === 'image') {
    if (job.inputPath) ctx.drawImage(await loadImage(job.inputPath), 0, 0, size, size);
  } else {
    const result = await renderVector(job);
    resourceWaitMs = result.resourceWaitMs;
    const image = ctx.createImageData(size, size);
    const pending = [...(job.outputs || [job])];
    while (pending.length) {
      // An active prefetch may gain foreground requests while rendering. Give
      // those PNGs to clients first, without waiting for the rest to be encoded.
      let index = pending.findIndex(tile => job.requested?.includes(tile.outPath));
      if (index === -1) index = Math.max(0, pending.findIndex(tile => tile.outPath === job.outPath));
      const tile = pending.splice(index, 1)[0];
      copyTilePixels(result.pixels, result.layout, tile, size, image.data);
      ctx.putImageData(image, 0, 0);
      encodeMs += await saveTile(canvas, ctx, tile.outPath, job.pngCompression, true);
      previewTile(job, canvas, tile.outPath);
    }
  }
  if (job.kind === 'composite' || job.kind === 'image') {
    encodeMs = await saveTile(canvas, ctx, job.outPath, job.pngCompression);
    previewTile(job, canvas, job.outPath);
  }
  const cpu = process.cpuUsage(cpuStart);
  return { resourceWaitMs, encodeMs, cpuMs: Math.round((cpu.user + cpu.system) / 1000) };
}
let busy = false, currentJob;
process.on('message', async job => {
  if (job.promote) {
    if (currentJob) {
      currentJob.priority = Math.min(currentJob.priority ?? 0, job.promote.priority);
      if (job.promote.priority === 0 && !currentJob.requested.includes(job.promote.outPath)) currentJob.requested.push(job.promote.outPath);
      if (retained?.context) retained.context.priority = currentJob.priority;
    }
    return;
  }
  if (busy) return;
  busy = true; currentJob = job; job.requested ||= [];
  try {
    const timings = await run(job); busy = false; currentJob = null;
    if (process.connected) process.send({ done: true, timings, rssBytes: process.memoryUsage.rss() });
  } catch (err) {
    releaseMap(); console.error(err.message);
    if (process.connected) process.send({ error: err.message }, () => process.exit(1));
    else process.exit(1);
  }
});
process.on('disconnect', () => { releaseMap(); process.exit(0); });
