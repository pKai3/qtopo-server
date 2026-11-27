const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { httpError } = require('./utils');

const REVISION = /^[a-f0-9]{64}$/;
const PHASES = new Set(['starting', 'downloading', 'preparing', 'assembling', 'ready', 'error', 'waiting-space', 'disabled']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
async function readJson(file) {
  const stat = await fs.lstat(file);
  // The statewide publication retains provenance for all 343 source sheets.
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid contour manifest');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
function validatePublication(value, revision) {
  if (value?.format !== 1 || !REVISION.test(value.revision) || (revision && value.revision !== revision)
      || value.file !== `published/${value.revision}.mbtiles`
      || !Array.isArray(value.bounds) || value.bounds.length !== 4 || !value.bounds.every(Number.isFinite)
      || value.bounds[0] < -180 || value.bounds[2] > 180 || value.bounds[1] < -85.05113 || value.bounds[3] > 85.05113
      || value.bounds[0] >= value.bounds[2] || value.bounds[1] >= value.bounds[3]
      || !Number.isInteger(value.minzoom) || !Number.isInteger(value.maxzoom) || value.minzoom < 0 || value.maxzoom > 22 || value.maxzoom < value.minzoom
      || typeof value.attribution !== 'string' || !value.attribution || value.attribution.length > 2000
      || !Number.isSafeInteger(value.sheets) || value.sheets < 1) throw new Error('Invalid contour publication');
  return value;
}

function createNswContours(config, logger = {}, dependencies = {}) {
  const launch = dependencies.spawn || spawn;
  const now = dependencies.now || Date.now;
  const enabled = config.nswContoursEnabled === true;
  const root = config.nswContoursDir || path.join(config.dataDir, 'contours/nsw');
  const databases = new Map();
  let publication, lastStatus = {}, checked = 0, pending, child, childExit, retryTimer, pollTimer, started = false, stopping = false, lastError;
  let totals = { totalSheets: 0, totalBytes: 0 }, nextRetryAt;
  let progressKey, progressLoggedAt = 0, startedAt;

  async function openDatabase(manifest, entry) {
    const realRoot = await fs.realpath(root);
    const candidate = path.join(root, manifest.file);
    const [realFile, stat] = await Promise.all([fs.realpath(candidate), fs.lstat(candidate)]);
    if (!stat.isFile() || path.dirname(realFile) !== path.join(realRoot, 'published') || stat.size < 512) throw new Error('Contour tile file is unavailable');
    const db = new DatabaseSync(realFile, { readOnly: true, enableForeignKeyConstraints: false, allowExtension: false });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const metadata = Object.fromEntries(db.prepare('SELECT name, value FROM metadata').all().map(row => [row.name, row.value]));
      const layers = JSON.parse(metadata.json || '{}').vector_layers;
      if (metadata.format !== 'pbf' || !layers?.some(layer => layer.id === 'contours' && layer.fields?.elevation === 'Number')) throw new Error('Contour tiles have the wrong layer or elevation field');
      entry.query = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
      entry.db = db;
    } catch (error) { db.close(); throw error; }
  }
  function release(entry) {
    entry.readers--;
    for (const [key, old] of databases) {
      if (databases.size <= 3) break;
      if (old.db && !old.readers && key !== publication?.revision) { old.db.close(); databases.delete(key); }
    }
  }
  async function database(manifest) {
    if (stopping) throw httpError('Contour service is stopping', 503);
    let entry = databases.get(manifest.revision);
    if (!entry) {
      entry = { manifest, readers: 0 };
      databases.set(manifest.revision, entry);
      entry.ready = openDatabase(manifest, entry).catch(error => { databases.delete(manifest.revision); throw error; });
    }
    // Reserve before awaiting the open: parallel requests cannot close each
    // other's handles or open the same database twice.
    entry.readers++;
    try { await entry.ready; if (stopping) throw httpError('Contour service is stopping', 503); return entry; }
    catch (error) { release(entry); throw error; }
  }
  function warn(error) {
    if (lastError !== error.message) logger.warn?.('CONTOURS', error.message);
    lastError = error.message;
  }
  async function refresh(force = false) {
    if (!enabled || stopping) return;
    if (pending) return pending;
    if (!force && Date.now() - checked < 1000) return;
    pending = (async () => {
      try { lastStatus = await readJson(path.join(root, 'status.json')); }
      catch (error) { if (error.code !== 'ENOENT') warn(error); }
      try {
        const next = validatePublication(await readJson(path.join(root, 'current.json')));
        if (publication?.revision !== next.revision) {
          const entry = await database(next);
          publication = next;
          release(entry);
          lastError = undefined;
          logger.log?.('CONTOURS', `NSW 2 m tiles ready (${next.sheets} sheets, ${next.revision.slice(0, 12)})`);
        }
      } catch (error) { if (error.code !== 'ENOENT') warn(error); }
      checked = Date.now();
      logProgress();
    })().finally(() => { pending = undefined; });
    return pending;
  }
  function status() {
    const available = enabled && Boolean(publication);
    const reported = PHASES.has(lastStatus.phase) ? lastStatus.phase : 'starting';
    const phase = !enabled ? 'disabled' : child ? (reported === 'ready' ? 'starting' : reported)
      : nextRetryAt ? (reported === 'waiting-space' ? reported : 'error') : available ? 'ready' : reported;
    return {
      enabled, available,
      phase,
      completedSheets: available && phase === 'ready' ? publication.sheets : count(lastStatus.completedSheets),
      totalSheets: count(lastStatus.totalSheets) || totals.totalSheets || publication?.sheets || 0,
      downloadedBytes: count(lastStatus.downloadedBytes) || (available ? count(publication.sourceBytes) : 0),
      totalBytes: count(lastStatus.totalBytes) || totals.totalBytes || count(publication?.sourceBytes),
      currentSheet: typeof lastStatus.currentSheet === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,149}$/.test(lastStatus.currentSheet) ? lastStatus.currentSheet : null,
      updatedAt: typeof lastStatus.updatedAt === 'string' ? lastStatus.updatedAt.slice(0, 64) : null,
      ...(nextRetryAt ? { nextRetryAt } : {}),
    };
  }
  function logProgress() {
    if (!started || stopping) return;
    const progress = status();
    const key = [progress.phase, progress.currentSheet, progress.completedSheets, progress.nextRetryAt].join('/');
    const timestamp = now();
    if (key === progressKey && (!child || timestamp - progressLoggedAt < 30_000)) return;
    progressKey = key;
    progressLoggedAt = timestamp;
    const elapsed = Math.max(0, Math.floor((timestamp - startedAt) / 1000));
    const details = [
      `NSW 2 m: ${progress.phase}`,
      `${progress.completedSheets}/${progress.totalSheets} sheets prepared`,
      `${(progress.downloadedBytes / 1e9).toFixed(2)}/${(progress.totalBytes / 1e9).toFixed(2)} GB downloaded`,
      ...(progress.currentSheet ? [`sheet ${progress.currentSheet}`] : []),
      ...(progress.phase === 'preparing' && count(lastStatus.featuresPrepared) ? [`${count(lastStatus.featuresPrepared)} contour lines read`] : []),
      `${Math.floor(elapsed / 60)}m ${elapsed % 60}s since start`,
      ...(progress.nextRetryAt ? [`retry at ${progress.nextRetryAt}`] : []),
    ];
    logger.log?.('CONTOURS', details.join('; '));
  }
  async function readTile(revision, tile) {
    if (!enabled) throw httpError('NSW 2 m contours are disabled', 503);
    if (!REVISION.test(revision)) throw httpError('Invalid contour dataset revision', 400);
    let manifest = databases.get(revision)?.manifest;
    if (!manifest) {
      try { manifest = validatePublication(await readJson(path.join(root, 'published', `${revision}.json`)), revision); }
      catch (error) { if (error.code === 'ENOENT') throw httpError('Unknown contour dataset revision', 404); throw error; }
    }
    const entry = await database(manifest);
    try {
      if (tile.z < entry.manifest.minzoom || tile.z > entry.manifest.maxzoom) return null;
      const row = entry.query.get(tile.z, tile.x, 2 ** tile.z - tile.y - 1);
      return row ? Buffer.from(row.tile_data) : null;
    } finally { release(entry); }
  }
  function retry() {
    if (stopping || !started || !enabled || retryTimer) return;
    nextRetryAt = new Date(Date.now() + config.nswContoursRetryMs).toISOString();
    retryTimer = setTimeout(() => { retryTimer = undefined; run(); }, config.nswContoursRetryMs);
    retryTimer.unref();
  }
  function run() {
    if (stopping || child || !enabled) return;
    nextRetryAt = undefined;
    const args = [path.join(config.root, 'scripts/nsw-contours.py'), '--data-dir', root, '--catalog', config.nswContoursCatalog,
      '--min-free-bytes', String(Math.ceil(config.cacheMinFreeBytes)), '--threads', String(config.nswContoursThreads)];
    try {
      const current = launch('python3', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONUNBUFFERED: '1', GDAL_CACHEMAX: '128', TIPPECANOE_MAX_THREADS: String(config.nswContoursThreads) } });
      child = current;
      let exited;
      childExit = new Promise(resolve => { exited = resolve; });
      for (const stream of [current.stdout, current.stderr]) stream?.on('data', data => {
        const message = data.toString().trim(); if (message) logger.log?.('CONTOURS', message.slice(-2000));
      });
      const done = async (code, error) => {
        exited();
        if (child !== current) return;
        child = undefined;
        if (stopping) return;
        if (error) warn(error);
        await refresh(true);
        if (code !== 0 || !publication) retry();
      };
      current.once('error', error => done(-1, error));
      current.once('exit', code => done(code));
      logger.log?.('CONTOURS', 'Checking retained NSW 2 m packages and resuming background preparation');
    } catch (error) { warn(error); retry(); }
  }
  async function start() {
    if (started || stopping || !enabled) return;
    started = true;
    startedAt = now();
    try {
      const catalog = JSON.parse(await fs.readFile(config.nswContoursCatalog, 'utf8'));
      totals = { totalSheets: catalog.sheets.length, totalBytes: catalog.sheets.reduce((total, sheet) => total + count(sheet.bytes), 0) };
    } catch (error) { warn(error); }
    if (stopping) return;
    await refresh(true);
    if (stopping) return;
    pollTimer = setInterval(() => refresh().catch(warn), 2000); pollTimer.unref();
    run();
  }
  async function close() {
    stopping = true;
    clearTimeout(retryTimer); clearInterval(pollTimer);
    if (child) {
      const current = child;
      try {
        if (process.platform !== 'win32' && current.pid) process.kill(-current.pid, 'SIGTERM');
        else current.kill('SIGTERM');
      } catch (error) { if (error.code !== 'ESRCH') warn(error); }
      let timeout;
      await Promise.race([childExit, new Promise(resolve => { timeout = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && current.pid) process.kill(-current.pid, 'SIGKILL');
          else current.kill('SIGKILL');
        } catch (error) { if (error.code !== 'ESRCH') warn(error); }
        resolve();
      }, 8000); })]);
      clearTimeout(timeout);
    }
    await pending;
    await Promise.allSettled([...databases.values()].map(entry => entry.ready));
    for (const entry of databases.values()) entry.db?.close();
    databases.clear();
  }
  return {
    refresh, start, close, readTile, status,
    get dataset() {
      if (!enabled || !publication) return undefined;
      return { revision: publication.revision, tiles: `/contours/nsw/${publication.revision}/{z}/{x}/{y}.pbf`,
        bounds: publication.bounds, minzoom: publication.minzoom, maxzoom: publication.maxzoom, attribution: publication.attribution };
    },
  };
}
module.exports = { createNswContours, validatePublication };
