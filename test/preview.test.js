const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { loadConfig } = require('../lib/config');
const { createProviders } = require('../lib/providers');

test('automatic vector preview follows the state border and never selects the raster automatic source', async () => {
  const { createStateSelector, selectPreview } = await import('../public/preview.mjs');
  const selectState = createStateSelector(JSON.parse(await fs.readFile(require.resolve('../assets/nsw-coverage.geojson'), 'utf8')));
  const providers = Object.values(createProviders(loadConfig({})));
  const automatic = { id: 'auto', type: 'vector', raster: '/raster/{z}/{x}/{y}.png' };
  for (const [lng, lat, expected] of [
    [152.5178, -27.8374, 'qld'], [151.933, -28.654, 'qld'],
    [150.31, -33.72, 'nsw'], [153.54, -28.186, 'nsw'], [149.13, -35.28, 'nsw'],
    [153.54 + 360, -28.186, 'nsw'], [152.5178 - 360, -27.8374, 'qld'],
  ]) {
    const result = selectPreview(automatic, 'vector', providers, { lng, lat }, selectState);
    assert.equal(result.mode, 'vector'); assert.equal(result.provider.type, 'vector');
    assert.equal(result.provider.id, expected);
  }
  const raster = selectPreview(automatic, 'raster', providers, { lng: 150.31, lat: -33.72 }, () => assert.fail('raster selection must stay automatic'));
  assert.equal(raster.mode, 'raster'); assert.equal(raster.provider, automatic);
  const sheets = selectPreview(providers.find(p => p.id === 'nsw-topo'), 'vector', providers);
  assert.equal(sheets.mode, 'raster', 'map sheets must honestly report raster mode');
  const qld = providers.find(p => p.id === 'qld');
  assert.equal(selectPreview(qld, 'vector', providers, { lng: 150.31, lat: -33.72 }, selectState).provider, qld, 'explicit state selection stays fixed');
});
