#!/usr/bin/env node
const { createCanvas, loadImage } = require('canvas');
const fs = require('node:fs/promises');
const { atomicWrite } = require('./utils');

let retained;
function releaseMap() {
  if (!retained) return;
  for (const controller of retained.context?.controllers || []) controller.abort();
  retained.map.release(); retained = null;
}
async function renderVector(job) {
  const key = JSON.stringify([job.origin, job.size, job.styleKey || job.style]);
  if (retained && (retained.key !== key || Date.now() >= retained.expires)) releaseMap();
  const context = { controllers: new Set(), error: null, waitingSince: 0, waitMs: 0 };
  if (!retained) {
    const mbgl = require('@maplibre/maplibre-gl-native');
    const state = { key, context, expires: Date.now() + job.resourceMaxAgeMs };
    state.map = new mbgl.Map({
      mode: 'tile', ratio: job.size / 512,
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
        fetch(url, { signal: controller.signal }).then(async res => {
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
    // Keep the XYZ footprint at 512 logical pixels; ratio=2 gives native
    // 1024px detail without enlarging an already rendered bitmap.
    const pixels = await new Promise((resolve, reject) => retained.map.render({
      zoom: job.z, center: tileCenter(job.z, job.x, job.y), width: 512, height: 512, bearing: 0, pitch: 0,
    }, (err, data) => err ? reject(err) : resolve(data)));
    if (context.error) throw context.error;
    const resourceWaitMs = currentWait(context);
    return { pixels, resourceWaitMs };
  } catch (err) { releaseMap(); throw err; }
  finally { for (const controller of context.controllers) controller.abort(); }
}
function currentWait(context) {
  return Math.round(context.waitMs + (context.controllers.size ? performance.now() - context.waitingSince : 0));
}

function tileCenter(z, x, y) {
  const n = 2 ** z;
  return [(x + 0.5) / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI];
}
async function run(job) {
  const cpuStart = process.cpuUsage();
  let resourceWaitMs = 0;
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
    const pixels = result.pixels; resourceWaitMs = result.resourceWaitMs;
    if (pixels.length !== size * size * 4) throw new Error(`Unexpected render size: ${pixels.length}`);
    const image = ctx.createImageData(size, size);
    image.data.set(pixels);
    ctx.putImageData(image, 0, 0);
  }
  const pixels = ctx.getImageData(0, 0, size, size).data;
  let empty = true;
  for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]) { empty = false; break; } }
  if (empty) await atomicWrite(job.outPath + '.empty', '1');
  const encodeStarted = performance.now();
  const png = canvas.toBuffer('image/png', { compressionLevel: 3 });
  const encodeMs = Math.round(performance.now() - encodeStarted);
  await atomicWrite(job.outPath, png);
  // Keep the old negative marker until its replacement image is complete.
  if (!empty) await fs.rm(job.outPath + '.empty', { force: true });
  const cpu = process.cpuUsage(cpuStart);
  return { resourceWaitMs, encodeMs, cpuMs: Math.round((cpu.user + cpu.system) / 1000) };
}
let busy = false;
process.on('message', async job => {
  if (busy) return;
  busy = true;
  try {
    const timings = await run(job); busy = false;
    if (process.connected) process.send({ done: true, timings });
  } catch (err) {
    releaseMap(); console.error(err.message);
    if (process.connected) process.send({ error: err.message }, () => process.exit(1));
    else process.exit(1);
  }
});
process.on('disconnect', () => { releaseMap(); process.exit(0); });
