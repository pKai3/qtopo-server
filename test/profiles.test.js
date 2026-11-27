const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateStyleMin } = require('@maplibre/maplibre-gl-style-spec');
const { loadConfig } = require('../lib/config');
const { createProviders } = require('../lib/providers');
const { seedStyles, createStyleCache, getStyle, styleRevision, renderStyle } = require('../lib/styles');
const { profiles } = require('../lib/profiles');

test('profiles validate for both states, preserve Classic and keep independent cache identities', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-profiles-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ DATA_DIR: dir }), providers = createProviders(config);
  await seedStyles(config, providers);
  const cache = createStyleCache(config);
  for (const id of ['qld', 'nsw']) {
    const provider = providers[id], original = await getStyle(config, provider), revisions = new Set(), emptyRevisions = new Set();
    const appearanceProfiles = profiles.filter(profile => profile.id !== 'nsw-2m');
    for (const profile of appearanceProfiles) {
      const prepared = await cache.get(provider, profile.id);
      assert.equal(prepared, await cache.get(provider, profile.id));
      revisions.add(prepared.revision); emptyRevisions.add(prepared.atZoom(null).revision);
      assert.deepEqual(validateStyleMin(prepared.style), [], `${id}/${profile.id}`);
      for (const scale of [0.5, 1, 3]) assert.deepEqual(validateStyleMin(renderStyle(prepared.style, scale)), []);
      assert.deepEqual(prepared.style.sources, original.sources, 'no change to source detail or tile coordinates');
      for (const layer of prepared.style.layers.filter(l => l.id.startsWith('powerlines-'))) {
        const before = original.layers.find(l => l.id === layer.id);
        if (profile.refined) {
          assert.equal(layer.paint['line-color'], '#858a8b');
          assert.equal(layer.paint['line-width'], 1, 'power lines stay thin at every display scale');
          assert.deepEqual(layer.paint['line-dasharray'], [4, 3]);
          assert.equal(layer.paint['line-opacity'], 0.75);
        } else {
          assert.equal(layer.paint['line-color'], before.paint['line-color']);
          assert.deepEqual(layer.paint['line-dasharray'], before.paint['line-dasharray']);
        }
      }
      for (const layer of prepared.style.layers) {
        const before = original.layers.find(l => l.id === layer.id);
        assert.deepEqual([layer.filter, layer.minzoom, layer.maxzoom], [before.filter, before.minzoom, before.maxzoom]);
      }
      if (profile.id === 'classic') {
        assert.deepEqual(prepared.style, original);
        assert.equal(prepared.revision, styleRevision(original, config, provider), 'reuse existing Classic tiles');
      }
      if (profile.factor === 1) for (const layer of prepared.style.layers) {
        const before = original.layers.find(l => l.id === layer.id);
        for (const key of ['text-size', 'icon-size']) assert.deepEqual(layer.layout?.[key], before.layout?.[key], `${profile.id}/${layer.id}/${key}`);
        if (profile.id === 'classic' || !layer.id.startsWith('powerlines-')) assert.deepEqual(layer.paint?.['line-width'], before.paint?.['line-width'], `${profile.id}/${layer.id}/line-width`);
      }
    }
    assert.equal(revisions.size, appearanceProfiles.length);
    assert.equal(emptyRevisions.size, appearanceProfiles.length, 'sparse NSW variants remain profile-specific');
    assert.deepEqual(await getStyle(config, provider), original, 'persisted styles are never rewritten');
  }
  const original = (await cache.get(providers.qld)).style;
  const mobile = (await cache.get(providers.qld, 'mobile-3x')).style;
  const before = original.layers.find(l => l.id === 'homesteads'), after = mobile.layers.find(l => l.id === 'homesteads');
  assert.equal(after.layout['icon-size'], 3, 'scale the implicit icon size too');
  assert.equal(after.layout['text-size'], before.layout['text-size'] * 3);
  assert.equal(after.layout['text-radial-offset'], 1.2, 'em offsets must not be multiplied twice');
  assert.deepEqual(after.layout['text-variable-anchor'], ['top', 'bottom', 'left', 'right']);
  const stream = mobile.layers.findIndex(l => l.id === 'watercourses-large');
  const lake = mobile.layers.findIndex(l => l.id === 'lake-large');
  assert.ok(stream < lake);
  assert.equal(mobile.layers[lake].paint['fill-opacity'], 1);
  assert.deepEqual(mobile.layers[stream].filter, original.layers.find(l => l.id === 'watercourses-large').filter, 'retain outside creek segments');
  const previous = await cache.get(providers.qld, 'mobile-2x');
  const edited = JSON.parse(await fs.readFile(providers.qld.stylePath));
  edited.layers.push({ id: 'extra', type: 'background' });
  await fs.writeFile(providers.qld.stylePath, JSON.stringify(edited));
  assert.notEqual((await cache.get(providers.qld, 'mobile-2x')).revision, previous.revision);
});

test('default profile accepts built-ins or a valid custom name', () => {
  assert.equal(loadConfig({}).defaultProfile, 'readable');
  assert.equal(loadConfig({ DEFAULT_PROFILE: 'my-mobile' }).defaultProfile, 'my-mobile');
  for (const p of profiles) assert.equal(loadConfig({ DEFAULT_PROFILE: p.id }).defaultProfile, p.id);
  for (const value of ['constructor', '../classic', 'raster', 'UPPERCASE']) assert.throws(() => loadConfig({ DEFAULT_PROFILE: value }), /Unknown DEFAULT_PROFILE/);
});
