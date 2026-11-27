const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProfileCatalog, validateProfile, readProfile, syncProfile, migrateLegacyProfiles } = require('../lib/profile-files');
const { createStyleCache, seedStyles } = require('../lib/styles');
const { NSW_CONTOUR_SOURCE } = require('../lib/profiles');
const { createProviders } = require('../lib/providers');
const { loadConfig } = require('../lib/config');
const { main } = require('../scripts/profiles');
function document(id = 'test-mobile', color = '#123456') {
  const style = { version: 8, sources: { map: { type: 'vector', tiles: ['https://example.invalid/{z}/{x}/{y}.pbf'] } },
    layers: [{ id: 'roads', type: 'line', source: 'map', 'source-layer': 'Roads', paint: { 'line-color': color, 'line-width': 1 } }] };
  return { format: 1, id, name: 'Test mobile', styles: { qld: structuredClone(style), nsw: structuredClone(style) } };
}
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-profile-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { ...loadConfig({ DATA_DIR: dir }), root: path.join(dir, 'image') };
  const input = path.join(dir, 'upload.json');
  return { config, input, dir };
}
test('sync validates before activation, backs up old versions and supports rollback without deleting caches', async t => {
  const { config, input } = await setup(t), first = document();
  await fs.writeFile(input, JSON.stringify(first));
  assert.equal((await syncProfile(config, input)).changed, true);
  const target = path.join(config.profileDir, 'test-mobile.json'), before = await fs.readFile(target);
  assert.equal((await syncProfile(config, input)).changed, false);
  await fs.writeFile(input, '{broken');
  await assert.rejects(syncProfile(config, input));
  assert.deepEqual(await fs.readFile(target), before);
  await fs.writeFile(input, JSON.stringify(document('test-mobile', '#abcdef')));
  assert.equal((await main(['sync', input], config)).changed, true);
  const history = await fs.readdir(path.join(config.profileDir, 'history'));
  assert.equal(history.length, 1);
  await syncProfile(config, path.join(config.profileDir, 'history', history[0]));
  assert.deepEqual(await readProfile(target), first);
  assert.equal((await main(['validate', target], config)).valid, true);
});
test('live reload preserves in-flight snapshots, rejects bad files and isolates source and cache revisions', async t => {
  const { config, input } = await setup(t), warnings = [];
  const catalog = createProfileCatalog(config, { warn: (...args) => warnings.push(args) });
  const providers = createProviders(config), styles = createStyleCache(config);
  await fs.writeFile(input, JSON.stringify(document())); await syncProfile(config, input); await catalog.refresh(true);
  const old = catalog.get('test-mobile'), oldStyle = await styles.get(providers.qld, old);
  assert.match(oldStyle.style.sources.map.tiles[0], /^\/vector\/qld\//, 'external tile URLs are replaced by the provider proxy');
  assert.equal(oldStyle.style.sprite, '/assets/sprites/qld');
  const nswBefore = await styles.get(providers.nsw, old);
  const changed = document(); changed.styles.qld.layers[0].paint['line-color'] = '#abcdef';
  await fs.writeFile(input, JSON.stringify(changed)); await syncProfile(config, input); await catalog.refresh(true);
  const current = catalog.get('test-mobile'), currentStyle = await styles.get(providers.qld, current);
  assert.notEqual(current.token, old.token);
  assert.notEqual(currentStyle.revision, oldStyle.revision);
  assert.equal((await styles.get(providers.nsw, current)).revision, nswBefore.revision, 'unchanged NSW pixels reuse their cache');
  assert.equal((await styles.get(providers.qld, old)).revision, oldStyle.revision, 'older requests retain their captured style');
  const target = path.join(config.profileDir, 'test-mobile.json');
  await fs.writeFile(target, '{partial upload'); await catalog.refresh(true);
  assert.equal(catalog.get('test-mobile').token, current.token); assert.equal(warnings.length, 1);
  await catalog.refresh(true); assert.equal(warnings.length, 1, 'do not flood logs for unchanged invalid data');
  await fs.writeFile(input, JSON.stringify(document('test-mobile', '#fedcba'))); await syncProfile(config, input); await catalog.refresh(true);
  assert.notEqual(catalog.get('test-mobile').token, current.token, 'recover after a valid upload');
});
test('committed profiles are defaults; live overrides survive image changes and can be exported', async t => {
  const { config, input } = await setup(t), bundled = path.join(config.root, 'styles');
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'test-mobile.json'), JSON.stringify(document()));
  const catalog = createProfileCatalog(config); await catalog.refresh(true);
  assert.equal(catalog.get('test-mobile').styles.qld.layers[0].paint['line-color'], '#123456');
  await fs.writeFile(input, JSON.stringify(document('test-mobile', '#abcdef'))); await syncProfile(config, input);
  await fs.writeFile(path.join(bundled, 'test-mobile.json'), JSON.stringify(document('test-mobile', '#000000')));
  await catalog.refresh(true);
  assert.equal(catalog.get('test-mobile').styles.qld.layers[0].paint['line-color'], '#abcdef');
  const output = path.join(config.dataDir, 'export.json');
  await main(['export', 'test-mobile', output], config);
  assert.equal((await readProfile(output)).styles.qld.layers[0].paint['line-color'], '#abcdef');
  await assert.rejects(main(['export', 'test-mobile', output], config), /EEXIST/);
  await fs.unlink(path.join(config.profileDir, 'test-mobile.json')); await catalog.refresh(true);
  assert.equal(catalog.get('test-mobile').styles.qld.layers[0].paint['line-color'], '#000000');
});
test('profile inputs cannot replace Classic, escape their directory or add network source types', async t => {
  for (const id of ['classic', 'style', 'profiles', '../escape', 'api', 'raster', 'constructor', 'A', 'a'.repeat(49)]) assert.throws(() => validateProfile(document(id)), /name/);
  const missing = document(); delete missing.styles.nsw; assert.throws(() => validateProfile(missing), /qld and nsw/);
  const bad = document(); bad.styles.qld.layers[0].paint['line-width'] = 'huge'; assert.throws(() => validateProfile(bad), /qld/);
  const remote = document(); remote.styles.qld.sources.map = { type: 'geojson', data: 'https://example.invalid/private' };
  assert.throws(() => validateProfile(remote));
  const spoofedContours = document();
  spoofedContours.styles.nsw.sources['nsw-2m-contours'] = { type: 'vector', tiles: ['https://example.invalid/private/{z}/{x}/{y}.pbf'] };
  assert.throws(() => validateProfile(spoofedContours), /reserved/);
  const collision = document(); collision.styles.nsw.layers[0].id = 'nsw-2m-contours-50m';
  assert.throws(() => validateProfile(collision), /reserved/);
  const { config, input } = await setup(t); await fs.writeFile(input, JSON.stringify(document()));
  const link = path.join(config.dataDir, 'symlink.json'); await fs.symlink(input, link);
  await assert.rejects(syncProfile(config, link), /regular JSON file/);
});
test('CLI accepts bounded stdin and exports JSON for SSH streaming', async t => {
  const { config } = await setup(t), { Readable } = require('node:stream');
  const stream = value => Readable.from([JSON.stringify(value)]);
  await main(['sync', '-'], config, stream(document()));
  assert.equal((await main(['validate', '-'], config, stream(document()))).valid, true);
  const exported = await main(['export', 'test-mobile', '-'], config);
  assert.equal(exported.id, 'test-mobile');
  await assert.rejects(main(['sync', '-'], config, Readable.from(['x'.repeat(8 * 1024 * 1024 + 1)])), /8 MiB/);
  const official = document(); official.styles.qld.sprite = '/resources/qld/sprites/sprite';
  await syncProfile(config, official);
  const catalog = createProfileCatalog(config); await catalog.refresh(true);
  const prepared = await createStyleCache(config).get(createProviders(config).qld, catalog.get(official.id));
  assert.equal(prepared.style.sprite, '/resources/qld/sprites/sprite');
  assert.equal(prepared.style.glyphs, '/resources/qld/fonts/{fontstack}/{range}.pbf');
});

test('2 m profile exports editable Readable base styles before any contour dataset is ready', async t => {
  const { config } = await setup(t), providers = createProviders(config);
  await seedStyles({ ...config, root: path.resolve(__dirname, '..') }, providers);
  const exported = await main(['export', 'nsw-2m', '-'], config), cache = createStyleCache(config);
  assert.equal(exported.id, 'nsw-2m'); assert.equal(exported.name, 'NSW · 2 m contours');
  for (const id of ['qld', 'nsw']) assert.deepEqual(exported.styles[id], (await cache.get(providers[id], 'readable')).style);
  assert.ok(!Object.hasOwn(exported.styles.nsw.sources, NSW_CONTOUR_SOURCE));
  assert.ok(!JSON.stringify(exported).includes('/contours/nsw/'), 'exports do not pin a prepared dataset');
  assert.deepEqual(validateProfile(exported), exported);
  const output = path.join(config.dataDir, 'nsw-2m-export.json');
  await main(['export', 'nsw-2m', output], config);
  assert.deepEqual(await readProfile(output), exported);
});

test('2 m export edits survive sync and re-export while rendering uses the current prepared dataset', async t => {
  const { Readable } = require('node:stream'), { config } = await setup(t), providers = createProviders(config);
  await seedStyles({ ...config, root: path.resolve(__dirname, '..') }, providers);
  const editable = await main(['export', 'nsw-2m', '-'], config);
  editable.name = 'My NSW 2 m map';
  editable.styles.nsw.layers.find(layer => layer.type === 'background').paint['background-color'] = '#eef0e8';
  await main(['sync', '-'], config, Readable.from([JSON.stringify(editable)]));
  assert.deepEqual(await main(['export', 'nsw-2m', '-'], config), editable, 'live base edits round-trip without adding generated sources');
  const catalog = createProfileCatalog(config); await catalog.refresh(true);
  const profile = catalog.get('nsw-2m'), cache = createStyleCache(config);
  await assert.rejects(cache.get(providers.nsw, profile), { status: 503 }, 'importing a base style does not bypass dataset readiness');
  const prepared = character => ({ ...profile, contourDataset: {
    revision: character.repeat(64), tiles: `/contours/nsw/${character.repeat(64)}/{z}/{x}/{y}.pbf`,
    bounds: [140.99, -37.6, 159.3, -28.15], minzoom: 10, maxzoom: 16, attribution: '© State of New South Wales · CC BY 3.0 AU',
  } });
  const first = await cache.get(providers.nsw, prepared('a')), current = await cache.get(providers.nsw, prepared('b'));
  assert.notEqual(first.revision, current.revision);
  assert.deepEqual(current.style.sources[NSW_CONTOUR_SOURCE].tiles, [prepared('b').contourDataset.tiles]);
  assert.equal(current.style.layers.filter(layer => layer.source === NSW_CONTOUR_SOURCE).length, 5);
  assert.ok(!current.style.layers.some(layer => ['Contours', 'Contours/label'].includes(layer['source-layer'])));
  assert.equal(current.style.layers.find(layer => layer.type === 'background').paint['background-color'], '#eef0e8');
  assert.deepEqual((await cache.get(providers.qld, prepared('b'))).style, editable.styles.qld);
  assert.deepEqual(await main(['export', 'nsw-2m', '-'], config), editable, 'the new active dataset never enters the editable document');
});

test('2 m appearance follows live Readable styles and revisions in catalog, rendering and export', async t => {
  const { config } = await setup(t), catalog = createProfileCatalog(config), providers = createProviders(config), cache = createStyleCache(config);
  await catalog.refresh(true);
  const builtin = catalog.get('nsw-2m');
  await syncProfile(config, document('readable', '#246810')); await catalog.refresh(true);
  const inherited = catalog.get('nsw-2m');
  assert.equal(inherited.name, builtin.name);
  assert.equal(inherited.id, 'nsw-2m');
  assert.equal(inherited.styles, catalog.get('readable').styles);
  assert.equal(catalog.list().find(profile => profile.id === 'nsw-2m'), inherited);
  assert.notEqual(inherited.token, builtin.token);
  const withDataset = profile => ({ ...profile, contourDataset: {
    revision: 'a'.repeat(64), tiles: `/contours/nsw/${'a'.repeat(64)}/{z}/{x}/{y}.pbf`,
    bounds: [140.99, -37.6, 159.3, -28.15], minzoom: 10, maxzoom: 16, attribution: 'NSW Spatial Services',
  } });
  const before = await cache.get(providers.nsw, withDataset(inherited));
  assert.equal(before.style.layers.find(layer => layer.id === 'roads').paint['line-color'], '#246810');
  await syncProfile(config, document('readable', '#abcdef')); await catalog.refresh(true);
  const current = catalog.get('nsw-2m'), after = await cache.get(providers.nsw, withDataset(current));
  assert.notEqual(current.token, inherited.token, 'live base edits invalidate inherited prefetch work');
  assert.notEqual(after.revision, before.revision, 'live base edits invalidate inherited PNGs');
  assert.equal(after.style.layers.find(layer => layer.id === 'roads').paint['line-color'], '#abcdef');
  assert.equal(inherited.styles.nsw.layers[0].paint['line-color'], '#246810', 'earlier profile snapshots keep their base');
  assert.equal(before.style.layers.find(layer => layer.id === 'roads').paint['line-color'], '#246810');
  await catalog.refresh(true);
  assert.equal(catalog.get('nsw-2m').token, current.token, 'unchanged scans keep the same cache token');
  assert.equal(catalog.list().find(profile => profile.id === 'nsw-2m'), catalog.get('nsw-2m'));
  assert.equal(await cache.get(providers.nsw, withDataset(catalog.get('nsw-2m'))), after);
  const exported = await main(['export', 'nsw-2m', '-'], config);
  assert.equal(exported.id, 'nsw-2m');
  for (const id of ['qld', 'nsw']) assert.deepEqual(exported.styles[id], (await cache.get(providers[id], catalog.get('readable'))).style);
  assert.ok(!Object.hasOwn(exported.styles.nsw.sources, NSW_CONTOUR_SOURCE));
});

test('an explicit 2 m override wins over Readable until removed, then resumes the current fallback', async t => {
  const { config } = await setup(t), catalog = createProfileCatalog(config);
  await syncProfile(config, document('readable', '#123456'));
  const own = document('nsw-2m', '#665544'); own.name = 'My contour appearance';
  await syncProfile(config, own); await catalog.refresh(true);
  const override = catalog.get('nsw-2m');
  assert.equal(override.name, own.name); assert.deepEqual(override.styles, own.styles);
  await syncProfile(config, document('readable', '#fedcba')); await catalog.refresh(true);
  assert.equal(catalog.get('nsw-2m'), override, 'changing Readable cannot change an explicit 2 m profile');
  assert.equal(catalog.list().find(profile => profile.id === 'nsw-2m'), override);
  await fs.unlink(path.join(config.profileDir, 'nsw-2m.json')); await catalog.refresh(true);
  const inherited = catalog.get('nsw-2m');
  assert.equal(inherited.styles, catalog.get('readable').styles);
  assert.equal(inherited.styles.nsw.layers[0].paint['line-color'], '#fedcba');
  assert.notEqual(inherited.token, override.token);
  await fs.unlink(path.join(config.profileDir, 'readable.json')); await catalog.refresh(true);
  assert.equal(catalog.get('nsw-2m').styles, undefined, 'removing the live base restores the built-in recipe');
  assert.equal(catalog.get('nsw-2m').token, 'builtin-1');
  assert.equal(catalog.list().find(profile => profile.id === 'nsw-2m'), catalog.get('nsw-2m'));
});

test('upgrade moves live profiles and history into styles while preserving render identities and originals', async t => {
  const { config } = await setup(t), legacy = path.join(config.dataDir, 'profiles');
  assert.equal(config.profileDir, config.styleDir);
  const oldConfig = { ...config, profileDir: legacy };
  await syncProfile(oldConfig, document('test-mobile', '#abcdef'));
  await syncProfile(oldConfig, document('test-mobile', '#123456'));
  const original = '{"version":8,"sources":{},"layers":[]}\n';
  await fs.mkdir(config.styleDir, { recursive: true });
  await fs.writeFile(path.join(config.styleDir, 'style.json'), original);
  await fs.writeFile(path.join(config.styleDir, 'custom-map.json'), original);
  const oldCatalog = createProfileCatalog(oldConfig); await oldCatalog.refresh(true);
  const before = oldCatalog.get('test-mobile');
  const warnings = [], catalog = createProfileCatalog(config, { warn: (...args) => warnings.push(args) });
  await catalog.refresh(true);
  assert.equal(catalog.get('test-mobile').token, before.token);
  const styles = createStyleCache(config), provider = createProviders(config).qld;
  assert.equal((await styles.get(provider, before)).revision, (await styles.get(provider, catalog.get('test-mobile'))).revision);
  assert.equal(await fs.readFile(path.join(config.styleDir, 'style.json'), 'utf8'), original);
  assert.equal((await fs.readdir(path.join(config.styleDir, 'history'))).length, 1);
  await assert.rejects(fs.stat(legacy), { code: 'ENOENT' });
  assert.deepEqual(warnings, []);
});

test('migration keeps newer styles, archives conflicting legacy edits and respects custom directories', async t => {
  const { config } = await setup(t), legacy = path.join(config.dataDir, 'profiles');
  const old = document('test-mobile', '#abcdef'), current = document('test-mobile', '#123456');
  await fs.mkdir(legacy, { recursive: true }); await fs.mkdir(config.styleDir, { recursive: true });
  await fs.writeFile(path.join(legacy, 'test-mobile.json'), JSON.stringify(old));
  await fs.writeFile(path.join(config.styleDir, 'test-mobile.json'), JSON.stringify(current));
  await migrateLegacyProfiles({ ...config, profileDir: path.join(config.dataDir, 'custom') });
  assert.ok(await fs.stat(path.join(legacy, 'test-mobile.json')));
  await migrateLegacyProfiles(config);
  assert.deepEqual(await readProfile(path.join(config.styleDir, 'test-mobile.json')), current);
  const history = await fs.readdir(path.join(config.styleDir, 'history'));
  assert.equal(history.length, 1);
  assert.deepEqual(await readProfile(path.join(config.styleDir, 'history', history[0])), old);
  await migrateLegacyProfiles(config); // Safe to repeat on subsequent CLI calls.
  assert.equal((await fs.readdir(path.join(config.styleDir, 'history'))).length, 1);
});
