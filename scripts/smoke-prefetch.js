const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
const { createProviders } = require('../lib/providers');
const { getStyle, styleRevision } = require('../lib/styles');
const { neighbours, zoomNeighbours } = require('../lib/prefetch');
const origin = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    if (i === 59) throw new Error('Server never became ready');
    await sleep(500);
  }
  const tile = { z: 13, x: 7578, y: 4746 };
  const url = t => `${origin}/raster/${t.z}/${t.x}/${t.y}.png`;
  const response = await fetch(url(tile));
  assert.equal(response.status, 200); await response.arrayBuffer();
  const config = loadConfig(), provider = createProviders(config).qld;
  const revision = styleRevision(await getStyle(config, provider), config, provider);
  let status;
  for (let i = 0; i < 180; i++) {
    status = await (await fetch(origin + '/readyz')).json();
    if (status.prefetch.completed >= 13 && status.prefetch.active === 0) break;
    await sleep(500);
  }
  assert.equal(status.prefetch.completed, 13, 'only eight neighbours plus five zoom tiles, with no recursive prefetch');
  assert.equal(status.prefetch.completedZoom, 5);
  assert.equal(status.prefetch.queued, 0);
  assert.ok(status.renderer.peakActive >= 3, 'native prefetch must actually use multiple workers');
  assert.ok(status.renderer.peakActive <= config.prefetchConcurrency, 'background capacity must remain bounded');
  const expected = [...neighbours(tile, 1), ...zoomNeighbours(tile)];
  const cachedTiles = [];
  for (const t of expected) {
    const file = path.join(config.rasterDir, 'v2', 'qld', revision, `${t.z}`, `${t.x}`, `${t.y}.png`);
    const data = await fs.readFile(file);
    assert.equal(data.readUInt32BE(16), 1024); assert.equal(data.readUInt32BE(20), 1024);
    cachedTiles.push(data);
  }
  const started = performance.now(), result = await fetch(url(expected.at(-1)));
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), cachedTiles.at(-1));
  const cachedMs = Math.round(performance.now() - started);
  console.log('Eight neighbours and five zoom tiles already cached:', cachedMs, 'ms;', JSON.stringify(status));
  await fs.mkdir('/tmp/smoke', { recursive: true });
  await fs.writeFile('/tmp/smoke/prefetch.json', JSON.stringify({ cachedMs, status }, null, 2));
}
main().catch(err => { console.error(err); process.exit(1); });
