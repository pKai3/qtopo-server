#!/usr/bin/env node
const { createCanvas, loadImage } = require('canvas');
const fs = require('node:fs/promises');
const { atomicWrite } = require('./utils');

function tileCenter(z, x, y) {
  const n = 2 ** z;
  return [(x + 0.5) / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI];
}
async function run(job) {
  const size = job.size;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (job.kind === 'image') {
    if (job.inputPath) ctx.drawImage(await loadImage(job.inputPath), 0, 0, size, size);
  } else {
    const mbgl = require('@maplibre/maplibre-gl-native');
    const controllers = new Set();
    let requestError;
    const map = new mbgl.Map({
      mode: 'tile', ratio: size / 512,
      request(req, callback) {
        let url;
        try { url = new URL(req.url); }
        catch { return callback(new Error('Invalid resource URL')); }
        if (url.origin !== job.origin) return callback(new Error('Renderer resources must be served by this server'));
        const controller = new AbortController(); controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), job.timeoutMs);
        fetch(url, { signal: controller.signal }).then(async res => {
          if (res.status === 204) return callback(null, {});
          if (!res.ok) throw new Error(`Resource HTTP ${res.status}: ${url.pathname}`);
          callback(null, { data: Buffer.from(await res.arrayBuffer()) });
        }).catch(err => { requestError = err; callback(err); })
          .finally(() => { clearTimeout(timer); controllers.delete(controller); });
      },
    });
    try {
      map.load(job.style);
      // The camera stays at a 512px logical tile. Pixel ratio controls output resolution.
      const pixels = await new Promise((resolve, reject) => map.render({
        zoom: job.z, center: tileCenter(job.z, job.x, job.y), width: 512, height: 512, bearing: 0, pitch: 0,
      }, (err, data) => err ? reject(err) : resolve(data)));
      if (requestError) throw requestError;
      if (pixels.length !== size * size * 4) throw new Error(`Unexpected render size: ${pixels.length}`);
      const image = ctx.createImageData(size, size);
      image.data.set(pixels);
      ctx.putImageData(image, 0, 0);
    } finally { map.release(); for (const controller of controllers) controller.abort(); }
  }
  const pixels = ctx.getImageData(0, 0, size, size).data;
  let empty = true;
  for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]) { empty = false; break; } }
  if (empty) await atomicWrite(job.outPath + '.empty', '1');
  await atomicWrite(job.outPath, canvas.toBuffer('image/png'));
  // Keep the old negative marker until its replacement image is complete.
  if (!empty) await fs.rm(job.outPath + '.empty', { force: true });
}
process.once('message', job => run(job).then(() => process.exit(0)).catch(err => {
  console.error(err.message);
  if (process.connected) process.send({ error: err.message }, () => process.exit(1));
  else process.exit(1);
}));
