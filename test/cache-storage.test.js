const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCacheFiles } = require('../lib/cache-files');
const { createCacheStorage } = require('../lib/cache-storage');

async function setup(t, options = {}, diskOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-storage-'));
  const config = { vectorDir: path.join(root, 'vector'), rasterDir: path.join(root, 'raster'), resourceDir: path.join(root, 'resources'),
    vectorTTL: 0, rasterTTL: 0, resourceTTL: 0, emptyTTL: 1000, cleanupInterval: 0,
    cacheMaxBytes: 100, cacheMinFreeBytes: 0, ...options };
  for (const dir of [config.vectorDir, config.rasterDir, config.resourceDir]) await fs.mkdir(path.join(dir, 'v2'), { recursive: true });
  const files = createCacheFiles();
  const storage = createCacheStorage(config, undefined, { files, autoStart: false, statfs: async () => ({ bavail: 10000, bsize: 1 }), ...diskOptions });
  t.after(async () => { await storage.close(); await fs.rm(root, { recursive: true, force: true }); });
  const put = async (name, size, age = 10000, directory = config.rasterDir) => {
    const file = path.join(directory, 'v2', name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.alloc(size));
    await fs.utimes(file, new Date(Date.now() - age), new Date(Date.now() - age)); return file;
  };
  return { root, config, files, storage, put };
}
const exists = file => fs.access(file).then(() => true, () => false);

test('maximum cache size evicts oldest files down to a recovery margin', async t => {
  const s = await setup(t);
  const old = await s.put('old.png', 60, 20000), fresh = await s.put('fresh.png', 60, 1000);
  const status = await s.storage.check();
  assert.equal(await exists(old), false); assert.equal(await exists(fresh), true);
  assert.equal(status.cacheBytes, 60); assert.equal(status.removed, 1); assert.equal(status.blocked, false);
});

test('minimum free space triggers cleanup independently of the cache-size limit', async t => {
  let s, initial = 0;
  s = await setup(t, { cacheMaxBytes: 0, cacheMinFreeBytes: 80 }, { statfs: async () => {
    let used = 0;
    for (const name of ['old.png', 'new.png', 'newest.png']) used += (await fs.stat(path.join(s.config.rasterDir, 'v2', name)).catch(() => ({ size: 0 }))).size;
    return { bavail: 20 + initial - used, bsize: 1 };
  } });
  const old = await s.put('old.png', 60, 30000), next = await s.put('new.png', 60, 20000), newest = await s.put('newest.png', 60, 1000); initial = 180;
  const status = await s.storage.check();
  assert.equal(await exists(old), false); assert.equal(await exists(next), false); assert.equal(await exists(newest), true);
  assert.ok(status.freeBytes >= 88); assert.equal(status.blocked, false);
});

test('shared readers and PNG sidecars remain protected during eviction', async t => {
  const s = await setup(t);
  const old = await s.put('old.png', 60, 30000), newest = await s.put('new.png', 60, 1000);
  await fs.writeFile(old + '.empty', '1');
  const releaseA = await s.files.hold(old), releaseB = await s.files.hold(old);
  const status = await s.storage.check();
  assert.equal(await exists(old), true); assert.equal(await exists(old + '.empty'), true); assert.equal(await exists(newest), false);
  releaseA();
  assert.equal(await s.files.evict(old, () => assert.fail('second reader still needs the tile')), false);
  releaseB();
  await s.put('extra.png', 80, 500);
  await s.storage.check();
  assert.equal(await exists(old), false); assert.equal(await exists(old + '.empty'), false);
  assert.equal(status.cacheBytes, 61);
});

test('cleanup satisfies both cache size and free disk thresholds before stopping', async t => {
  let s;
  s = await setup(t, { cacheMaxBytes: 120, cacheMinFreeBytes: 80 }, { statfs: async () => {
    let used = 0;
    for (const name of ['old.png', 'middle.png', 'new.png']) used += (await fs.stat(path.join(s.config.rasterDir, 'v2', name)).catch(() => ({ size: 0 }))).size;
    return { bavail: 200 - used, bsize: 1 };
  } });
  await s.put('old.png', 60, 30000); await s.put('middle.png', 60, 20000); const newest = await s.put('new.png', 60, 1000);
  const status = await s.storage.check();
  assert.equal(status.removed, 2); assert.equal(status.cacheBytes, 60); assert.equal(status.freeBytes, 140);
  assert.equal(await exists(newest), true); assert.equal(status.blocked, false);
});

test('a file refreshed after scanning is not deleted using its old age', async t => {
  const s = await setup(t), file = await s.put('old.png', 120, 30000);
  const evict = s.files.evict;
  s.files.evict = async (target, remove) => {
    const replacement = target + '.replacement';
    await fs.writeFile(replacement, Buffer.alloc(120)); await fs.rename(replacement, target);
    return evict(target, remove);
  };
  const status = await s.storage.check();
  assert.equal(await exists(file), true); assert.equal(status.removed, 0); assert.equal(status.blocked, true);
});

test('a symlink at a configured cache root cannot cause deletion outside that root', async t => {
  const s = await setup(t), external = path.join(s.root, 'private');
  await fs.mkdir(external); await fs.writeFile(path.join(external, 'keep.png'), Buffer.alloc(1000));
  await fs.rmdir(path.join(s.config.rasterDir, 'v2'));
  await fs.symlink(external, path.join(s.config.rasterDir, 'v2'));
  assert.equal((await s.storage.check()).readFailed, true);
  assert.equal(await exists(path.join(external, 'keep.png')), true);
});

test('a request arriving during deletion waits and observes a normal cache miss', async t => {
  const s = await setup(t), file = await s.put('tile.png', 60);
  let releaseDeletion;
  const gate = new Promise(resolve => { releaseDeletion = resolve; });
  const deletion = s.files.evict(file, async () => { await gate; await fs.unlink(file); });
  let acquired = false;
  const reader = s.files.hold(file).then(release => { acquired = true; return release; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(acquired, false);
  releaseDeletion(); await deletion;
  const release = await reader; assert.equal(await exists(file), false); release();
});

test('unreclaimable pressure is reported without deleting active files, user data or symlink targets', async t => {
  const s = await setup(t);
  const active = await s.put('active.png', 120), release = await s.files.hold(active);
  const userFile = await s.put('notes.png.backup', 500);
  const outside = path.join(s.root, 'styles'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.png'), Buffer.alloc(500));
  await fs.symlink(outside, path.join(s.config.rasterDir, 'v2', 'linked'));
  const status = await s.storage.check();
  assert.equal(status.blocked, true); assert.equal(status.cacheBytes, 120);
  assert.equal(await exists(active), true); assert.equal(await exists(userFile), true); assert.equal(await exists(path.join(outside, 'keep.png')), true);
  release();
  assert.equal((await s.storage.check()).blocked, false);
});

test('expiry still works without a storage budget and recent temporary writes are retained', async t => {
  const s = await setup(t, { cacheMaxBytes: 0, rasterTTL: 1000, cleanupInterval: 1 });
  const old = await s.put('old.png', 30, 10000), current = await s.put('current.png', 30, 100);
  const temporary = await s.put('current.png.1.id.tmp', 20, 10000);
  await s.storage.check();
  assert.equal(await exists(old), false); assert.equal(await exists(current), true); assert.equal(await exists(temporary), true);
});

test('failed disk readings are visible and a later successful check clears the fault', async t => {
  let fail = true;
  const s = await setup(t, {}, { statfs: async () => { if (fail) throw new Error('disk read failed'); return { bavail: 10000, bsize: 1 }; } });
  assert.equal((await s.storage.check()).readFailed, true);
  fail = false;
  const status = await s.storage.check(); assert.equal(status.readFailed, false); assert.equal(status.blocked, false);
});

test('readiness recovers when another program frees space, even with expiry cleanup disabled', async t => {
  let free = 20;
  const s = await setup(t, { cacheMaxBytes: 0, cacheMinFreeBytes: 80 }, { statfs: async () => ({ bavail: free, bsize: 1 }) });
  assert.equal((await s.storage.check()).blocked, true);
  free = 100;
  await s.storage.probe();
  assert.equal(s.storage.stats.blocked, false); assert.equal(s.storage.stats.pressure, false);
});
