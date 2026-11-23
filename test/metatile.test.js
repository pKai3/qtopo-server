const { test } = require('node:test');
const assert = require('node:assert/strict');
const { metatileLayout, copyTilePixels } = require('../lib/metatile');
const { loadConfig } = require('../lib/config');
test('metatiles use fixed grids and keep their XYZ footprint at every output density', () => {
  const tile = { z: 8, x: 237, y: 149 }, layout = metatileLayout(tile);
  for (const sibling of layout.tiles) assert.deepEqual(metatileLayout(sibling), layout);
  assert.equal(layout.width, 1152); assert.equal(layout.height, 1152);
  assert.equal(layout.mode, 'static');
  const n = 2 ** tile.z, [lng, lat] = layout.center;
  assert.ok(Math.abs((lng + 180) / 360 * n - 237) < 1e-10);
  assert.ok(Math.abs((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) * n / 2 - 149) < 1e-10);
  for (const size of [256, 512, 1024]) {
    const ratio = size / 512, width = layout.width * ratio;
    const source = Buffer.alloc(width * layout.height * ratio * 4);
    for (let y = 0; y < layout.height * ratio; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4; source[i] = x % 251; source[i + 1] = y % 241; source[i + 3] = 255;
    }
    for (const sibling of layout.tiles) {
      const dest = new Uint8ClampedArray(size * size * 4);
      copyTilePixels(source, layout, sibling, size, dest);
      const sx = (sibling.x - layout.x) * size + layout.left * ratio;
      const sy = (sibling.y - layout.y) * size + layout.top * ratio;
      for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
        assert.deepEqual([...dest.slice((y * size + x) * 4, (y * size + x) * 4 + 4)], [(sx + x) % 251, (sy + y) % 241, 0, 255]);
      }
    }
  }
});
test('world edges do not shift or stretch the crop and single-tile fallback is configurable', () => {
  for (const z of [0, 1, 5]) for (const corner of [0, 2 ** z - 1]) {
    const layout = metatileLayout({ z, x: corner, y: corner });
    assert.ok(layout.width <= 512 * 2 ** z);
    assert.ok(layout.height <= 512 * 2 ** z);
    assert.ok(layout.tiles.every(t => t.x >= 0 && t.x < 2 ** z && t.y >= 0 && t.y < 2 ** z));
    const [lng, lat] = layout.center, n = 2 ** z;
    const worldX = (lng + 180) / 360 * n * 512 - layout.width / 2 + layout.left;
    const worldY = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) * n * 256 - layout.height / 2 + layout.top;
    assert.ok(Math.abs(worldX - layout.x * 512) < 1e-7);
    assert.ok(Math.abs(worldY - layout.y * 512) < 1e-7);
  }
  const old = metatileLayout({ z: 12, x: 3789, y: 2373 }, { metatileSize: 1, renderBufferPx: 0 });
  assert.equal(old.mode, 'tile'); assert.equal(old.width, 512); assert.equal(old.tiles.length, 1);
  assert.equal(loadConfig({}).metatileSize, 2);
  assert.equal(loadConfig({ METATILE_SIZE: '1' }).metatileSize, 1);
  assert.throws(() => loadConfig({ METATILE_SIZE: '3' }), /METATILE_SIZE/);
  assert.throws(() => loadConfig({ RENDER_BUFFER_PX: '63' }), /even/);
  assert.throws(() => loadConfig({ RENDER_BUFFER_PX: '258' }), /RENDER_BUFFER_PX/);
});
