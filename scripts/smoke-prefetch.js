const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
const { createProviders } = require('../lib/providers');
const { getStyle, styleRevision } = require('../lib/styles');
const origin = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    if (i === 59) throw new Error('Server never became ready');
    await sleep(500);
  }
  const tile = { z: 13, x: 7578, y: 4746 }, neighbour = { ...tile, y: tile.y - 1 };
  const url = t => `${origin}/raster/${t.z}/${t.x}/${t.y}.png`;
  const response = await fetch(url(tile));
  assert.equal(response.status, 200); await response.arrayBuffer();
  const config = loadConfig(), provider = createProviders(config).qld;
  const revision = styleRevision(await getStyle(config, provider), config, provider);
  const file = path.join(config.rasterDir, 'v2', 'qld', revision, `${neighbour.z}`, `${neighbour.x}`, `${neighbour.y}.png`);
  let prefetched;
  for (let i = 0; i < 180; i++) {
    try { prefetched = await fs.readFile(file); if (prefetched.length) break; } catch (err) { if (err.code !== 'ENOENT') throw err; }
    await sleep(500);
  }
  assert.ok(prefetched?.length, 'adjacent PNG must be cached before it is requested');
  assert.equal(prefetched.readUInt32BE(16), 1024);
  assert.equal(prefetched.readUInt32BE(20), 1024);
  const started = performance.now(), result = await fetch(url(neighbour));
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), prefetched);
  const cachedMs = Math.round(performance.now() - started);
  const status = await (await fetch(origin + '/readyz')).json();
  assert.equal(status.prefetch.enabled, true);
  assert.ok(status.prefetch.completed > 0);
  console.log('Adjacent tile was already cached:', cachedMs, 'ms', JSON.stringify(status));
  await fs.mkdir('/tmp/smoke', { recursive: true });
  await fs.writeFile('/tmp/smoke/prefetch.json', JSON.stringify({ cachedMs, status }, null, 2));
}
main().catch(err => { console.error(err); process.exit(1); });
