// Runs inside the Linux CI container, using its existing HTTP resource server.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
const mbgl = require('@maplibre/maplibre-gl-native');
const { loadConfig } = require('../lib/config');
const { createRenderer } = require('../lib/render');
const { metatileLayout } = require('../lib/metatile');
const { renderStyle } = require('../lib/styles');
const origin = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const config = { ...loadConfig(), renderConcurrency: 1, renderQueueLimit: 16, renderTimeoutMs: 90000 };
const size = config.tilePx, root = '/tmp/smoke/metatile';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function idle(renderer) {
  for (let i = 0; i < 1000 && renderer.stats.active; i++) await sleep(10);
  assert.equal(renderer.stats.active, 0);
}
function jobFor(tile, options, style, folder, styleKey) {
  const layout = metatileLayout(tile, options);
  const file = t => path.join(folder, `${t.x}-${t.y}.png`);
  return { ...tile, kind: 'vector', size, origin, style, styleKey, layout, priority: 0,
    outPath: file(tile), outputs: layout.tiles.map(t => ({ ...t, outPath: file(t) })),
    renderKey: path.join(folder, `${layout.x}-${layout.y}`),
  };
}
function lngLat(z, x, y) {
  const n = 2 ** z;
  return [x / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI];
}
function pixels(canvas) { return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; }
async function labels() {
  const tile = { z: 8, x: 237, y: 149 }, layout = metatileLayout(tile), features = [];
  const point = (x, y, properties) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: lngLat(tile.z, x, y) } });
  features.push(point(layout.x + 0.97, layout.y + 0.5, { text: 'Across the tile boundary', angle: 0 }));
  features.push(point(layout.x + 0.5, layout.y + 0.97, { text: 'Across the row boundary', angle: 90 }));
  features.push(point(layout.x - 0.04, layout.y + 1.5, { text: 'Outside anchor', angle: 0 }));
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ff00ff'];
  layout.tiles.forEach((t, i) => features.push(point(t.x + 0.25, t.y + 0.25, { color: colors[i] })));
  const style = {
    version: 8, glyphs: origin + '/fonts/{fontstack}/{range}.pbf',
    sources: { fixture: { type: 'geojson', data: { type: 'FeatureCollection', features } } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#edf2e8' } },
      { id: 'landmarks', type: 'circle', source: 'fixture', filter: ['has', 'color'], paint: { 'circle-radius': 10, 'circle-color': ['get', 'color'] } },
      { id: 'labels', type: 'symbol', source: 'fixture', filter: ['has', 'text'], layout: {
        'text-field': ['get', 'text'], 'text-size': 24, 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-rotate': ['get', 'angle'],
      }, paint: { 'text-color': '#000', 'text-halo-color': '#fff', 'text-halo-width': 2 } },
    ],
  };
  const renderer = createRenderer(config);
  try {
    // Request the bottom-right tile first: output must not depend on request order.
    const first = jobFor(tile, {}, style, path.join(root, 'labels'), 'labels');
    const ordered = [tile, ...layout.tiles.filter(t => t.x !== tile.x || t.y !== tile.y)];
    await Promise.all(ordered.map(t => renderer.render({ ...first, ...t, outPath: first.outputs.find(o => o.x === t.x && o.y === t.y).outPath })));
    await idle(renderer);
    assert.equal(renderer.stats.completed, 1, 'four tile requests must use one native render');
    const stitched = createCanvas(size * 2, size * 2), ctx = stitched.getContext('2d');
    for (const output of first.outputs) {
      const image = await loadImage(await fs.readFile(output.outPath));
      assert.equal(image.width, size); assert.equal(image.height, size);
      ctx.drawImage(image, (output.x - layout.x) * size, (output.y - layout.y) * size);
    }
    const map = new mbgl.Map({ mode: 'static', ratio: size / 512, request(req, callback) {
      fetch(req.url).then(async r => { if (!r.ok) throw new Error(`Fixture resource HTTP ${r.status}`); callback(null, { data: Buffer.from(await r.arrayBuffer()) }); }).catch(callback);
    } });
    let full;
    try {
      map.load(style);
      full = await new Promise((resolve, reject) => map.render({ zoom: tile.z, center: layout.center, width: layout.width, height: layout.height }, (err, data) => err ? reject(err) : resolve(data)));
    } finally { map.release(); }
    const reference = createCanvas(layout.width * size / 512, layout.height * size / 512), rc = reference.getContext('2d');
    const image = rc.createImageData(reference.width, reference.height); image.data.set(full); rc.putImageData(image, 0, 0);
    const expected = rc.getImageData(layout.left * size / 512, layout.top * size / 512, size * 2, size * 2).data;
    assert.deepEqual(pixels(stitched), expected, 'stitched tiles must exactly match a single full-area render');
    const black = (x, y, w, h) => {
      const data = ctx.getImageData(x, y, w, h).data; let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 40 && data[i + 1] < 40 && data[i + 2] < 40 && data[i + 3] > 200) count++;
      return count;
    };
    assert.ok(black(size - 64, size / 2 - 64, 64, 128) > 20, 'label reaches the left side of the internal seam');
    assert.ok(black(size, size / 2 - 64, 64, 128) > 20, 'label continues on the right side of the internal seam');
    assert.ok(black(size / 2 - 64, size - 64, 128, 64) > 20, 'label reaches the top of the horizontal seam');
    assert.ok(black(size / 2 - 64, size, 128, 64) > 20, 'label continues below the horizontal seam');
    assert.ok(black(0, size * 1.5 - 64, 128, 128) > 20, 'padding includes a label whose anchor is outside the output grid');
    const rgba = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 0, 255, 255]];
    layout.tiles.forEach((t, i) => {
      const x = (t.x - layout.x + 0.25) * size, y = (t.y - layout.y + 0.25) * size;
      assert.deepEqual([...ctx.getImageData(x, y, 1, 1).data], rgba[i], 'landmarks retain their XYZ positions');
    });
    await fs.writeFile(`/tmp/smoke/label-seams-${size}.png`, stitched.toBuffer('image/png'));
    console.log('Native label seams, outer padding and georeferencing passed');
  } finally { renderer.close(); }
}
async function benchmark() {
  // Existing live smoke checks have already populated this server's resource
  // cache. Warm each worker once as well, then measure the same real QLD grid.
  const tile = { z: 13, x: 7579, y: 4747 }, tiles = metatileLayout(tile).tiles;
  const style = renderStyle(await (await fetch(origin + '/styles/qld.json')).json(), config.labelScale, true);
  const results = [];
  for (const [name, options] of [['single-unpadded', { metatileSize: 1, renderBufferPx: 0 }], ['single-padded', { metatileSize: 1, renderBufferPx: 64 }], ['metatile-2x2', { metatileSize: 2, renderBufferPx: 64 }]]) {
    const renderer = createRenderer(config), samples = [];
    try {
      for (let trial = 0; trial < 3; trial++) {
        const started = performance.now(); let firstMs;
        await Promise.all(tiles.map(t => renderer.render(jobFor(t, options, style, path.join(root, name, String(trial)), name)).then(() => { firstMs ??= performance.now() - started; })));
        await idle(renderer);
        if (trial) samples.push({ firstMs: Math.round(firstMs), fourTilesMs: Math.round(performance.now() - started) });
      }
      results.push({ name, samples });
    } finally { renderer.close(); }
  }
  await fs.writeFile('/tmp/smoke/metatile-timings.json', JSON.stringify({ pixels: size, concurrency: 1, resources: 'warm', results }, null, 2));
  console.log('Same-grid timing comparison:', JSON.stringify(results));
}
async function main() {
  // docker exec does not inherit the DISPLAY chosen dynamically by start.sh.
  // This CI helper runs alongside that server and must use its ready display.
  const displays = (await fs.readdir('/tmp')).filter(name => /^qtopo-display\.[A-Za-z0-9]+$/.test(name));
  assert.equal(displays.length, 1, 'expected one supervised X display');
  const display = (await fs.readFile(path.join('/tmp', displays[0]), 'utf8')).trim();
  assert.match(display, /^\d+$/);
  process.env.DISPLAY = ':' + display;
  await fs.mkdir(root, { recursive: true }); await labels(); await benchmark();
}
main().catch(err => { console.error(err); process.exitCode = 1; });
