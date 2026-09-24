const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createCanvas, loadImage } = require('canvas');
const origin = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const size = Number(process.env.TILE_PX || 512);
function tile(lng, lat, z) {
  const n = 2 ** z, phi = lat * Math.PI / 180;
  return { z, x: Math.floor((lng + 180) / 360 * n), y: Math.floor((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n) };
}
async function main() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    if (i === 59) throw new Error('Server never became ready');
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal((await fetch(origin + '/raster/nsw/2/4/0.png')).status, 400);
  const samples = [
    ['qld', 153.03, -27.47, 13],
    ['qld', 153.03, -27.47, 19],
    ['nsw', 150.31, -33.72, 12],
    ['nsw', 151.21, -33.87, 16],
    ['nsw-topo', 150.31, -33.72, 13],
    ['auto', 153.03, -27.47, 13],
    ['auto', 150.31, -33.72, 13],
    ['auto', 150.31, -33.72, 18],
    ['auto', 153.539, -28.176, 14],
  ];
  await fs.mkdir('/tmp/smoke', { recursive: true });
  const contact = createCanvas(512 * samples.length, 554), ctx = contact.getContext('2d');
  ctx.fillStyle = '#e4e7e1'; ctx.fillRect(0, 0, contact.width, contact.height);
  let col = 0;
  const timings = [];
  for (const [provider, lng, lat, z] of samples) {
    const t = tile(lng, lat, z), url = `${origin}/raster/${provider === 'auto' ? '' : provider + '/'}${t.z}/${t.x}/${t.y}.png`;
    console.log('Rendering', url);
    const started = performance.now();
    const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
    assert.equal(r.status, 200, await (r.ok ? Promise.resolve('') : r.text()));
    assert.match(r.headers.get('content-type'), /image\/png/);
    const data = Buffer.from(await r.arrayBuffer());
    const firstMs = Math.round(performance.now() - started);
    const image = await loadImage(data);
    const expected = provider === 'nsw-topo' ? 256 : size;
    assert.equal(image.width, expected); assert.equal(image.height, expected);
    const canvas = createCanvas(expected, expected), c = canvas.getContext('2d'); c.drawImage(image, 0, 0);
    const pixels = c.getImageData(0, 0, expected, expected).data;
    const colors = new Set(); let visible = 0, opaque = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]) { visible++; colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`); }
      if (pixels[i + 3] === 255) opaque++;
    }
    assert.ok(visible > 0 && colors.size > 20, `${provider} z${z} is empty or lacks map detail (${colors.size} colors)`);
    if (provider === 'nsw') assert.equal(opaque, expected * expected, 'NSW standalone maps must have an opaque background');
    await fs.writeFile(`/tmp/smoke/${provider}-z${z}-${size}-${t.x}-${t.y}.png`, data);
    if (provider === 'auto' && lat > -28) {
      const qld = await fetch(`${origin}/raster/qld/${t.z}/${t.x}/${t.y}.png`);
      assert.deepEqual(Buffer.from(await qld.arrayBuffer()), data, 'automatic QLD pixels must remain unchanged');
    }
    const cachedStarted = performance.now();
    const cached = await fetch(url); assert.deepEqual(Buffer.from(await cached.arrayBuffer()), data);
    const cachedMs = Math.round(performance.now() - cachedStarted);
    timings.push({ provider, z, pixels: expected, firstMs, cachedMs });
    ctx.drawImage(image, col * 512, 42, 512, 512);
    ctx.fillStyle = '#233b2b'; ctx.font = '18px sans-serif'; ctx.fillText(`${provider} · z${z} · ${expected}px`, col * 512 + 12, 27); col++;
    console.log(provider, z, expected, 'pixels;', colors.size, 'colors;', firstMs, 'ms first;', cachedMs, 'ms cached');
  }
  await fs.writeFile('/tmp/smoke/contact-' + size + '.png', contact.toBuffer('image/png'));
  await fs.writeFile('/tmp/smoke/timings-' + size + '.json', JSON.stringify(timings, null, 2));
  // A valid tile outside QLD must remain transparent, and have a short cache lifetime.
  const blank = await fetch(origin + '/raster/qld/5/1/1.png');
  assert.equal(blank.status, 200);
  assert.equal(blank.headers.get('cache-control'), 'public, max-age=1800');
  const blankImage = await loadImage(Buffer.from(await blank.arrayBuffer()));
  const blankCanvas = createCanvas(size, size), blankContext = blankCanvas.getContext('2d');
  blankContext.drawImage(blankImage, 0, 0);
  const blankPixels = blankContext.getImageData(0, 0, size, size).data;
  for (let i = 3; i < blankPixels.length; i += 4) assert.equal(blankPixels[i], 0);
  const catalog = await (await fetch(origin + '/api/providers')).json();
  assert.equal(catalog.providers.length, 3);
  console.log('All live map smoke checks passed');
}
main().catch(err => { console.error(err); process.exit(1); });
