const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProfileCatalog, validateProfile, readProfile, syncProfile } = require('../lib/profile-files');
const { createStyleCache } = require('../lib/styles');
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
  const { config, input } = await setup(t), bundled = path.join(config.root, 'profiles');
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
  for (const id of ['classic', '../escape', 'api', 'raster', 'constructor', 'A', 'a'.repeat(49)]) assert.throws(() => validateProfile(document(id)), /name/);
  const missing = document(); delete missing.styles.nsw; assert.throws(() => validateProfile(missing), /qld and nsw/);
  const bad = document(); bad.styles.qld.layers[0].paint['line-width'] = 'huge'; assert.throws(() => validateProfile(bad), /qld/);
  const remote = document(); remote.styles.qld.sources.map = { type: 'geojson', data: 'https://example.invalid/private' };
  assert.throws(() => validateProfile(remote));
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
