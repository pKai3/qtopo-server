const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
const origin = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const root = process.env.NSW_CONTOURS_DIR || path.join(process.env.DATA_DIR || '/data', 'contours/nsw');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  let status;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { status = await (await fetch(origin + '/api/contours')).json(); } catch {}
    if (status?.available && status.phase === 'ready') break;
    await pause(500);
  }
  assert.equal(status?.phase, 'ready', JSON.stringify(status));
  assert.equal(status.completedSheets, 1);
  assert.equal((await fetch(origin + '/readyz')).status, 200);
  const catalog = await (await fetch(origin + '/api/providers')).json();
  assert.ok(catalog.profiles.some(profile => profile.id === 'nsw-2m'));
  const style = await (await fetch(origin + '/styles/nsw-2m/nsw.json')).json();
  const source = style.sources['nsw-2m-contours'];
  assert.equal(source.maxzoom, 16);
  assert.ok(style.layers.some(layer => layer.id === 'nsw-2m-contours-2m'));
  assert.ok(!style.layers.some(layer => ['Contours', 'Contours/label'].includes(layer['source-layer'])));
  await fs.mkdir('/tmp/smoke', { recursive: true });
  for (const zoom of [16, 18]) {
    const n = 2 ** zoom, x = Math.floor((150.314 + 180) / 360 * n);
    const y = Math.floor((1 - Math.asinh(Math.tan(-33.6767 * Math.PI / 180)) / Math.PI) / 2 * n);
    const route = `/nsw-2m/${zoom}/${x}/${y}.png`;
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200, await (response.ok ? Promise.resolve('') : response.text()));
    const png = Buffer.from(await response.arrayBuffer()), image = await loadImage(png);
    assert.equal(image.width, Number(process.env.TILE_PX || 1024));
    const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let brown = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      // The generated contours use this brown family; water, roads and the
      // light background alone cannot satisfy this check in the small fixture.
      if (pixels[i] > pixels[i + 1] + 15 && pixels[i + 1] > pixels[i + 2] + 10 && pixels[i + 3] === 255) brown++;
    }
    assert.ok(brown > 30, `Prepared contours missing from native z${zoom} output (${brown} pixels)`);
    assert.deepEqual(Buffer.from(await (await fetch(origin + route)).arrayBuffer()), png);
    await fs.writeFile(`/tmp/smoke/contours-z${zoom}.png`, png);
    console.log(`Prepared 2 m contours rendered at z${zoom}: ${brown} contour-coloured pixels`);
  }
  const current = JSON.parse(await fs.readFile(path.join(root, 'current.json')));
  const stamp = { revision: current.revision, modified: (await fs.stat(path.join(root, current.file))).mtimeMs };
  const report = '/tmp/smoke/contours.json';
  try { assert.deepEqual(stamp, JSON.parse(await fs.readFile(report)), 'restart rebuilt the prepared tile set'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.writeFile(report, JSON.stringify(stamp));
  console.log('Contour boot, native rendering, immutable caching and retained publication checks passed');
}
main().catch(error => { console.error(error); process.exit(1); });
