const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { options, run } = require('../scripts/load-tiles');
const { httpError } = require('./utils');

// Delete only rendered images and their sidecars. Never follow symlinks or
// remove a whole configured directory, which could also contain user files.
async function clearRenderedTiles(root, progress) {
  async function walk(dir) {
    let entries;
    try {
      if (!(await fs.lstat(dir)).isDirectory()) return;
      entries = await fs.opendir(dir);
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for await (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        await fs.rmdir(file).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      } else if (entry.isFile() && /\.png(?:\.empty|(?:\.empty)?\.\d+\.[\w-]+\.tmp)?$/.test(entry.name)) {
        try {
          const stat = await fs.stat(file);
          await fs.unlink(file);
          progress.bytes += stat.size;
          if (entry.name.endsWith('.png')) progress.removed++;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  await walk(root);
}

function createStatusActions({ origin, rasterDir, maxzoom, busy, pause, resume, logger }) {
  let test = { phase: 'idle' }, clearing = { phase: 'idle', removed: 0, bytes: 0 }, controller;
  const shutdown = new AbortController();
  const cacheBusy = () => ['waiting', 'clearing'].includes(clearing.phase);
  const testBusy = () => ['running', 'stopping'].includes(test.phase);
  return {
    get stats() { return { test, clearing }; },
    get cacheBusy() { return cacheBusy(); },
    start(input) {
      if (shutdown.signal.aborted) throw httpError('Server shutting down', 503);
      if (cacheBusy()) throw httpError('Wait for the rendered tile cache to finish clearing.', 409);
      if (testBusy()) throw httpError('A tile test is already running.', 409);
      const keys = ['z', 'x', 'y', 'width', 'height', 'concurrency', 'timeout'];
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !keys.includes(key) || !Number.isInteger(input[key]))) throw httpError('Use numeric tile coordinates, dimensions and request limits.', 400);
      if (!origin()) throw httpError('Server is still starting.', 503);
      let settings;
      try { settings = options(['--url', origin(), ...Object.entries(input).flatMap(([key, value]) => [`--${key}`, String(value)])]); }
      catch (error) { throw httpError(error.message, 400); }
      if (settings.z > maxzoom) throw httpError(`Zoom must be between 0 and ${maxzoom}.`, 400);
      controller = new AbortController();
      const { url, ...publicSettings } = settings;
      test = { phase: 'running', startedAt: new Date().toISOString(), settings: publicSettings, progress: { requested: settings.width * settings.height, succeeded: 0, failed: 0, active: 0, bytes: 0, elapsedMs: 0 }, logs: [] };
      const current = test;
      // The destination always comes from the listening server, never user input.
      run(settings, line => {
        // The structured result is already displayed separately in the UI.
        if (!line.startsWith('{')) current.logs = [...current.logs, line].slice(-20);
      }, { signal: controller.signal, onProgress: progress => { current.progress = progress; } }).then(result => {
        current.phase = result.stopped ? 'stopped' : 'complete';
        current.result = { ...result, failures: result.failures.slice(0, 10) };
        logger?.log('TEST', `${result.succeeded}/${result.requested} tiles received, ${result.failed} failures, ${result.skipped} skipped (${result.elapsedMs} ms)`);
      }).catch(error => { current.phase = 'error'; current.error = error.message; logger?.err('TEST', error.message); });
      logger?.log('TEST', `Started ${settings.width * settings.height} tiles, ${settings.concurrency} concurrent requests`);
      return this.stats;
    },
    stop() {
      if (testBusy()) { test.phase = 'stopping'; controller.abort(); }
      return this.stats;
    },
    clear() {
      if (shutdown.signal.aborted) throw httpError('Server shutting down', 503);
      if (cacheBusy()) throw httpError('The rendered tile cache is already being cleared.', 409);
      if (testBusy()) throw httpError('Stop the tile test and wait for its current requests to finish first.', 409);
      clearing = { phase: 'waiting', startedAt: new Date().toISOString(), removed: 0, bytes: 0 };
      pause();
      const current = clearing;
      (async () => {
        const deadline = Date.now() + 300000;
        // Wait for HTTP delivery, resource preparation and full metatile jobs:
        // a requested PNG can be ready before its worker finishes its siblings.
        while (busy()) {
          if (Date.now() > deadline) throw new Error('Workers are still finishing. Try clearing again when idle.');
          await sleep(100, undefined, { signal: shutdown.signal });
        }
        if (shutdown.signal.aborted) return;
        current.phase = 'clearing';
        await clearRenderedTiles(rasterDir, current);
        current.phase = 'done';
        logger?.log('CACHE', `Cleared ${current.removed} rendered tiles (${current.bytes} bytes); downloaded resources retained`);
      })().catch(error => { current.phase = 'error'; current.error = error.message; logger?.err('CACHE', error.message); })
        .finally(() => { if (current.phase === 'waiting') current.phase = 'error'; resume(); });
      return this.stats;
    },
    close() { controller?.abort(); shutdown.abort(); },
  };
}
module.exports = { createStatusActions, clearRenderedTiles };
