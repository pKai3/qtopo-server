const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');
const { gzipSync } = require('node:zlib');
const { createNswContours, validatePublication } = require('../lib/nsw-contours');

const TILE = { z: 10, x: 5, y: 7 };
const DATA = gzipSync(Buffer.from('fixture contour tile'));

async function publication(root, digit = 'a', extra = {}, metadata = {}) {
  const revision = digit.repeat(64);
  const manifest = { format: 1, revision, file: `published/${revision}.mbtiles`,
    bounds: [150, -34, 151, -33], minzoom: 10, maxzoom: 16, sheets: 1,
    sourceBytes: 1234, attribution: 'NSW Spatial Services, CC BY 3.0 AU', ...extra };
  await fs.mkdir(path.join(root, 'published'), { recursive: true });
  const file = path.join(root, manifest.file);
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);');
    const values = { format: 'pbf', json: JSON.stringify({ vector_layers: [{ id: 'contours', fields: { elevation: 'Number' } }] }), ...metadata };
    for (const [name, value] of Object.entries(values)) db.prepare('INSERT INTO metadata VALUES (?, ?)').run(name, value);
    const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
    insert.run(TILE.z, TILE.x, 2 ** TILE.z - TILE.y - 1, DATA);
    insert.run(TILE.z, TILE.x, TILE.y, Buffer.from('opposite hemisphere'));
  } finally { db.close(); }
  await fs.chmod(file, 0o444);
  await fs.writeFile(path.join(root, 'published', `${revision}.json`), JSON.stringify(manifest));
  return manifest;
}

async function fixture(t, enabled = true, launch, dependencies = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qtopo-contour-store-'));
  const root = path.join(dir, 'contours');
  const config = { dataDir: dir, root: path.resolve(__dirname, '..'), nswContoursDir: root,
    nswContoursEnabled: enabled, nswContoursThreads: 2, nswContoursRetryMs: 60_000,
    nswContoursCatalog: path.join(dir, 'catalog.json'), cacheMinFreeBytes: 0 };
  let launches = 0;
  const warnings = [], logs = [];
  const store = createNswContours(config, { warn: (...args) => warnings.push(args), log: (...args) => logs.push(args) }, {
    ...dependencies,
    spawn(...args) { launches++; if (launch) return launch(...args); throw new Error('A read-only fixture must not launch an importer'); },
  });
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  async function publish(manifest) {
    await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(manifest));
    await store.refresh(true);
  }
  return { dir, root, config, store, publish, warnings, logs, launches: () => launches };
}

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for supervisor state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('read-only MBTiles converts XYZ to TMS and does not modify retained tiles', async t => {
  const f = await fixture(t), manifest = await publication(f.root);
  const file = path.join(f.root, manifest.file);
  const before = await fs.readFile(file), stat = await fs.stat(file);
  await f.publish(manifest);
  assert.deepEqual(await f.store.readTile(manifest.revision, TILE), DATA);
  assert.equal((await f.store.readTile(manifest.revision, { ...TILE, y: 1016 })).toString(), 'opposite hemisphere');
  assert.equal(await f.store.readTile(manifest.revision, { ...TILE, x: 6 }), null);
  assert.equal(await f.store.readTile(manifest.revision, { ...TILE, z: 9 }), null);
  assert.equal(await f.store.readTile(manifest.revision, { ...TILE, z: 17 }), null);
  await f.store.close();
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), [`${manifest.revision}.json`, `${manifest.revision}.mbtiles`]);
  assert.equal(f.launches(), 0);
});

test('old immutable revisions remain readable after publication changes and cache eviction', async t => {
  const f = await fixture(t);
  const first = await publication(f.root, 'a');
  await f.publish(first);
  for (const digit of ['b', 'c', 'd', 'e']) await f.publish(await publication(f.root, digit));
  assert.equal(f.store.dataset.revision, 'e'.repeat(64));
  assert.deepEqual(await f.store.readTile(first.revision, TILE), DATA);
  assert.equal(f.store.dataset.revision, 'e'.repeat(64), 'reading an old revision cannot change the current style');
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => f.store.readTile('abcde'[i % 5].repeat(64), TILE)));
  assert.ok(results.every(value => value.equals(DATA)));
});

test('malformed revisions are rejected and unknown revisions are not confused with missing tiles', async t => {
  const f = await fixture(t);
  await publication(f.root);
  for (const revision of ['../current', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '.json']) {
    await assert.rejects(f.store.readTile(revision, TILE), { status: 400 });
  }
  await assert.rejects(f.store.readTile('f'.repeat(64), TILE), { status: 404 });
});

test('invalid publication metadata and incomplete tile sets preserve the previous publication', async t => {
  const f = await fixture(t), good = await publication(f.root);
  await f.publish(good);
  const wrongLayer = await publication(f.root, 'b', {}, { json: JSON.stringify({ vector_layers: [{ id: 'wrong', fields: { elevation: 'Number' } }] }) });
  const wrongField = await publication(f.root, 'c', {}, { json: JSON.stringify({ vector_layers: [{ id: 'contours', fields: { elevation: 'String' } }] }) });
  const wrongFormat = await publication(f.root, 'd', {}, { format: 'png' });
  for (const candidate of [wrongLayer, wrongField, wrongFormat, { ...good, revision: 'e'.repeat(64), file: `published/${'e'.repeat(64)}.mbtiles` }, { ...good, file: '../outside.mbtiles' }]) {
    await f.publish(candidate);
    assert.equal(f.store.dataset.revision, good.revision);
    assert.deepEqual(await f.store.readTile(good.revision, TILE), DATA);
  }
  await fs.writeFile(path.join(f.root, 'current.json'), '{incomplete');
  await f.store.refresh(true);
  assert.equal(f.store.dataset.revision, good.revision);
  assert.ok(f.warnings.length > 0);
});

test('symlinked tile files outside the publication directory cannot become current', async t => {
  const f = await fixture(t), good = await publication(f.root);
  await f.publish(good);
  const candidate = await publication(f.root, 'b');
  const file = path.join(f.root, candidate.file), outside = path.join(f.dir, 'outside.mbtiles');
  await fs.rename(file, outside);
  await fs.symlink(outside, file);
  await f.publish(candidate);
  assert.equal(f.store.dataset.revision, good.revision);
  await assert.rejects(f.store.readTile(candidate.revision, TILE));
});

test('a statewide provenance manifest larger than 64 KiB is accepted while excessive JSON is rejected', async t => {
  const f = await fixture(t);
  const sources = Array.from({ length: 343 }, (_, i) => ({ id: `sheet-${i}`, url: `https://example.invalid/${'a'.repeat(160)}/${i}.zip`, sha256: '0'.repeat(64), bytes: 1000 }));
  const manifest = await publication(f.root, 'a', { sheets: sources.length, sources });
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) > 64 * 1024);
  await f.publish(manifest);
  assert.equal(f.store.dataset?.revision, manifest.revision);
  await f.publish({ ...manifest, revision: 'b'.repeat(64), file: `published/${'b'.repeat(64)}.mbtiles`, padding: 'x'.repeat(1024 * 1024) });
  assert.equal(f.store.dataset.revision, manifest.revision);
});

test('public progress keeps useful counts without publishing raw importer errors', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root, { recursive: true });
  await fs.writeFile(path.join(f.root, 'status.json'), JSON.stringify({ phase: 'error', completedSheets: -5,
    totalSheets: 343, downloadedBytes: 1024, totalBytes: 2048, currentSheet: 'Katoomba',
    updatedAt: '2026-11-27T00:00:00Z', message: '/private/secrets: upstream credentials failed',
    error: 'secret-value', traceback: '/private/importer.py:123' }));
  await f.store.refresh(true);
  const status = f.store.status();
  assert.equal(status.enabled, true); assert.equal(status.available, false);
  assert.equal(status.phase, 'error'); assert.equal(status.completedSheets, 0);
  assert.equal(status.totalSheets, 343); assert.equal(status.downloadedBytes, 1024);
  assert.equal(status.totalBytes, 2048); assert.equal(status.currentSheet, 'Katoomba');
  assert.doesNotMatch(JSON.stringify(status), /secret|private|traceback|credentials|message/);
});

test('disabled lifecycle never launches or opens a retained publication', async t => {
  const f = await fixture(t, false), manifest = await publication(f.root);
  await f.publish(manifest);
  await f.store.start(); await f.store.start();
  assert.equal(f.launches(), 0);
  assert.equal(f.store.dataset, undefined);
  assert.deepEqual({ enabled: f.store.status().enabled, available: f.store.status().available, phase: f.store.status().phase },
    { enabled: false, available: false, phase: 'disabled' });
  await assert.rejects(f.store.readTile(manifest.revision, TILE), { status: 503 });
});

test('supervision resumes after low disk space, launches once and waits for shutdown before closing tiles', async t => {
  const launches = [];
  const f = await fixture(t, true, (command, args, options) => {
    const child = new EventEmitter();
    const signals = [];
    child.kill = signal => { signals.push(signal); return true; };
    launches.push({ command, args, options, child, signals });
    return child;
  });
  f.config.nswContoursRetryMs = 100;
  f.config.cacheMinFreeBytes = 1234;
  await fs.writeFile(f.config.nswContoursCatalog, JSON.stringify({ sheets: [{ bytes: 1234 }, { bytes: 2000 }] }));
  const manifest = await publication(f.root);
  await f.publish(manifest);
  await fs.writeFile(path.join(f.root, 'status.json'), JSON.stringify({ phase: 'waiting-space', completedSheets: 0,
    totalSheets: 2, downloadedBytes: 1234, totalBytes: 3234, currentSheet: 'Katoomba' }));
  await f.store.start(); await f.store.start();
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, 'python3');
  assert.ok(launches[0].args.includes(f.config.nswContoursCatalog));
  assert.ok(launches[0].args.includes(f.root));
  assert.equal(launches[0].args[launches[0].args.indexOf('--min-free-bytes') + 1], '1234');
  assert.equal(launches[0].options.env.TIPPECANOE_MAX_THREADS, '2');
  assert.equal(f.store.status().phase, 'waiting-space');
  assert.equal(f.store.status().completedSheets, 0, 'the old publication must not replace progress of a new preparation');
  launches[0].child.emit('exit', 3);
  await until(() => f.store.status().nextRetryAt);
  assert.equal(f.store.status().phase, 'waiting-space', 'low disk space must remain visible while waiting to retry');
  assert.equal(f.store.status().available, true);
  assert.deepEqual(await f.store.readTile(manifest.revision, TILE), DATA);
  await until(() => launches.length === 2);
  let closed = false;
  const closing = f.store.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(launches[1].signals, ['SIGTERM']);
  assert.equal(closed, false, 'shutdown must wait for the importer to acknowledge termination');
  launches[1].child.emit('exit', 0);
  await closing;
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(launches.length, 2, 'closing must cancel any later preparation');
  await assert.rejects(f.store.readTile(manifest.revision, TILE), { status: 503 });
});

test('a failed importer launch schedules another attempt without requiring the retained directory to exist', async t => {
  let child;
  const f = await fixture(t, true, () => {
    if (!child) { child = new EventEmitter(); throw new Error('temporary process launch failure'); }
    child.kill = () => { child.emit('exit', 0); return true; };
    return child;
  });
  f.config.nswContoursRetryMs = 25;
  await fs.writeFile(f.config.nswContoursCatalog, JSON.stringify({ sheets: [{ bytes: 1234 }] }));
  await f.store.start();
  assert.equal(f.launches(), 1);
  assert.equal(f.store.status().phase, 'error');
  assert.ok(f.store.status().nextRetryAt);
  assert.equal(f.store.status().totalBytes, 1234);
  await until(() => f.launches() === 2);
  assert.doesNotMatch(JSON.stringify(f.store.status()), /temporary process launch failure/);
  await f.store.close();
});

test('background preparation logs stage changes and periodic progress without flooding logs or leaking raw status', async t => {
  let clock = 1_000_000, child;
  const f = await fixture(t, true, () => {
    child = new EventEmitter();
    child.kill = () => { child.emit('exit', 0); return true; };
    return child;
  }, { now: () => clock });
  await fs.mkdir(f.root, { recursive: true });
  await fs.writeFile(f.config.nswContoursCatalog, JSON.stringify({ sheets: [{ bytes: 2e9 }] }));
  const progress = { phase: 'downloading', totalSheets: 1, completedSheets: 0,
    downloadedBytes: 1e9, totalBytes: 2e9, currentSheet: 'Katoomba', message: '/private/secret' };
  const save = () => fs.writeFile(path.join(f.root, 'status.json'), JSON.stringify(progress));
  const lines = () => f.logs.filter(([, message]) => message.startsWith('NSW 2 m:')).map(([, message]) => message);
  await save();
  await f.store.refresh(true);
  assert.equal(lines().length, 0, 'read-only inspection must not start progress logging');
  await f.store.start();
  assert.match(lines()[0], /downloading; 0\/1 sheets prepared; 1\.00\/2\.00 GB downloaded; sheet Katoomba/);
  progress.downloadedBytes = 1.5e9;
  await save();
  clock += 29_999;
  await f.store.refresh(true);
  assert.equal(lines().length, 1, 'byte updates must not produce a log for every status poll');
  clock += 1;
  await f.store.refresh(true);
  assert.match(lines()[1], /1\.50\/2\.00 GB downloaded; sheet Katoomba; 0m 30s since start/);
  Object.assign(progress, { phase: 'preparing', featuresPrepared: 1234 });
  await save();
  await f.store.refresh(true);
  assert.match(lines()[2], /preparing.*1234 contour lines read/);
  clock += 30_000;
  await f.store.refresh(true);
  assert.equal(lines().length, 4, 'long-running tile assembly must still emit a heartbeat when the status file is unchanged');
  assert.doesNotMatch(lines().join('\n'), /private|secret/);
  Object.assign(progress, { phase: 'ready', completedSheets: 1, currentSheet: null });
  await save();
  await f.publish(await publication(f.root));
  child.emit('exit', 0);
  await until(() => f.store.status().phase === 'ready');
  await f.store.refresh(true);
  const readyCount = lines().length;
  assert.match(lines().at(-1), /ready; 1\/1 sheets prepared/);
  clock += 60_000;
  await f.store.refresh(true);
  assert.equal(lines().length, readyCount, 'completed preparation must not keep generating heartbeat logs');
});

test('publication validation rejects unsafe paths, mismatched revisions and invalid geographic extents', () => {
  const revision = 'a'.repeat(64);
  const good = { format: 1, revision, file: `published/${revision}.mbtiles`, bounds: [150, -34, 151, -33], minzoom: 10, maxzoom: 16, sheets: 1, attribution: 'NSW' };
  assert.equal(validatePublication(good, revision), good);
  for (const patch of [{ file: '/tmp/a.mbtiles' }, { file: `published/../${revision}.mbtiles` }, { bounds: [151, -34, 150, -33] },
    { bounds: [150, -90, 151, -33] }, { bounds: [150, -34, Infinity, -33] }, { minzoom: 17 }, { maxzoom: 23 }, { sheets: 0 }, { attribution: '' }]) {
    assert.throws(() => validatePublication({ ...good, ...patch }), /Invalid contour publication/);
  }
  assert.throws(() => validatePublication(good, 'b'.repeat(64)), /Invalid contour publication/);
});

test('assembly logs and public status expose measured counters and stage-only estimates without raw tool output', async t => {
  const f = await fixture(t, true, () => {
    const child = new EventEmitter();
    child.kill = () => { child.emit('exit', 0); return true; };
    return child;
  });
  await fs.mkdir(f.root, { recursive: true });
  await fs.writeFile(f.config.nswContoursCatalog, JSON.stringify({ sheets: [{ bytes: 1e9 }] }));
  const state = { phase: 'assembling', completedSheets: 343, totalSheets: 343, assembly: {
    stage: 'merging', countersAvailable: true, checkedFiles: 343, totalFiles: 343,
    inputTiles: 450, totalInputTiles: 1000, outputTiles: 250, outputBytes: 10.4e9,
    elapsedSeconds: 120, tilesPerSecond: 10, etaSeconds: 55, rawLog: '/private/secret', filename: 'private.db' } };
  const save = async () => {
    await fs.writeFile(path.join(f.root, 'status.json'), JSON.stringify(state));
    await f.store.refresh(true);
  };
  await save();
  await f.store.start();
  assert.equal(f.store.status().assembly.inputTiles, 450);
  assert.equal(f.store.status().assembly.etaSeconds, 55);
  let line = f.logs.find(([, message]) => message.includes('input tiles processed'))[1];
  assert.match(line, /450\/1000 input tiles processed \(45\.0%\).*10 input tiles\/s.*10\.40 GB written/);
  assert.match(line, /~1m for this stage; later checks not included/);
  assert.doesNotMatch(JSON.stringify(f.store.status()) + line, /secret|private|rawLog|filename/);
  state.assembly.tilesPerSecond = 0;
  await save();
  assert.equal(f.store.status().assembly.etaSeconds, undefined, 'stale estimates must disappear when progress stalls');
  Object.assign(state.assembly, { stage: 'validating', inputTiles: 1000 });
  await save();
  assert.match(f.logs.at(-1)[1], /validating merged map/);
  assert.doesNotMatch(f.logs.at(-1)[1], /~\d+m|343\/343 sheets prepared/);
  assert.equal(f.store.status().assembly.etaSeconds, undefined);
  state.phase = 'preparing';
  await save();
  assert.equal(f.store.status().assembly, undefined, 'old assembly progress must not follow another preparation stage');
});
