#!/usr/bin/env node
// A bounded HTTP workload: no cache deletion, server reconfiguration or retries.
const { setTimeout: sleep } = require('node:timers/promises');

function options(args) {
  const result = { url: 'http://127.0.0.1:8080', z: 16, x: 60500, y: 37950, width: 8, height: 8, concurrency: 8, timeout: 60 };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !Object.hasOwn(result, key) || args[i + 1] == null) throw new Error(`Unknown or incomplete option: ${args[i]}`);
    result[key] = key === 'url' ? args[i + 1] : Number(args[i + 1]);
  }
  const url = new URL(result.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) throw new Error('--url must be an HTTP(S) server URL without a query or fragment');
  result.url = result.url.replace(/\/+$/, '');
  for (const [key, min, max] of [['z', 0, 22], ['x', 0, 2 ** result.z - 1], ['y', 0, 2 ** result.z - 1], ['width', 1, 64], ['height', 1, 64], ['concurrency', 1, 64], ['timeout', 1, 300]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`--${key} must be an integer from ${min} to ${max}`);
  }
  if (result.x + result.width > 2 ** result.z || result.y + result.height > 2 ** result.z) throw new Error('Tile rectangle extends beyond the world');
  return result;
}

function tilesFor(o) {
  const tiles = [];
  for (let y = o.y; y < o.y + o.height; y++) for (let x = o.x; x < o.x + o.width; x++) tiles.push({ x, y });
  // Send one tile from every 2x2 grid before its siblings. Otherwise a small
  // request pool can all join the same render job and fail to exercise workers.
  return tiles.sort((a, b) => ((a.y % 2) * 2 + a.x % 2) - ((b.y % 2) * 2 + b.x % 2));
}

async function run(o, log = console.log, { signal, onProgress = () => {} } = {}) {
  const tiles = tilesFor(o), latencies = [], failures = [];
  let cursor = 0, active = 0, peakRequests = 0, peakRenders = 0, peakQueued = 0, bytes = 0, lastProgress = 0, observedStatus = false;
  const started = performance.now(), stop = new AbortController();
  const progress = () => onProgress({ requested: tiles.length, started: cursor, succeeded: latencies.length, failed: failures.length,
    active, bytes, elapsedMs: Math.round(performance.now() - started), peakRequests,
    peakRenderJobsObserved: observedStatus ? peakRenders : null, peakQueuedJobsObserved: observedStatus ? peakQueued : null });
  const status = async () => {
    try {
      const response = await fetch(o.url + '/readyz', { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(2000)]) });
      if (!response.ok) return;
      const data = await response.json();
      observedStatus = true;
      peakRenders = Math.max(peakRenders, data.renderer?.active || 0);
      peakQueued = Math.max(peakQueued, data.renderer?.queued || 0);
      return data;
    } catch { /* Older servers and proxies may not expose status. */ }
  };
  const before = await status();
  progress();
  log(`${tiles.length} tiles at z${o.z}, x${o.x}–${o.x + o.width - 1}, y${o.y}–${o.y + o.height - 1}; up to ${o.concurrency} HTTP requests at once.`);
  if (before) log(`Server render concurrency: ${before.settings?.renderConcurrency ?? before.renderer?.concurrency}; ${before.renderer?.active || 0} jobs already active.`);
  const monitor = (async () => {
    while (!stop.signal.aborted) {
      try { await sleep(250, undefined, { signal: stop.signal }); } catch { break; }
      await status();
      progress();
    }
  })();
  await Promise.all(Array.from({ length: Math.min(o.concurrency, tiles.length) }, async () => {
    while (cursor < tiles.length && !signal?.aborted) {
      const tile = tiles[cursor++], began = performance.now();
      active++; peakRequests = Math.max(peakRequests, active);
      const route = `/raster/${o.z}/${tile.x}/${tile.y}.png`;
      try {
        const response = await fetch(o.url + route, { signal: AbortSignal.timeout(o.timeout * 1000) });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        const body = Buffer.from(await response.arrayBuffer());
        if (body.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Response is not a PNG');
        bytes += body.length; latencies.push(performance.now() - began);
      } catch (error) { failures.push({ route, error: error.message }); }
      finally { active--; progress(); }
      if (performance.now() - lastProgress >= 1000) {
        log(`${latencies.length + failures.length}/${tiles.length} finished; ${active} HTTP requests in flight; peak ${peakRenders} render jobs observed.`);
        lastProgress = performance.now();
      }
    }
  }));
  const elapsedMs = Math.round(performance.now() - started), after = await status();
  stop.abort(); await monitor;
  latencies.sort((a, b) => a - b);
  const percentile = p => latencies.length ? Math.round(latencies[Math.ceil(latencies.length * p) - 1]) : null;
  const sameSession = before && after && before.startedAt === after.startedAt;
  const delta = key => sameSession && Number.isFinite(before.requests?.[key]) && Number.isFinite(after.requests?.[key]) ? after.requests[key] - before.requests[key] : null;
  const result = { requested: tiles.length, started: cursor, skipped: tiles.length - cursor, stopped: !!signal?.aborted, succeeded: latencies.length, failed: failures.length, elapsedMs, medianMs: percentile(0.5), p95Ms: percentile(0.95), bytes, peakRequests, peakRenderJobsObserved: observedStatus ? peakRenders : null, peakQueuedJobsObserved: observedStatus ? peakQueued : null, serverCacheHits: delta('hits'), serverCacheMisses: delta('misses'), failures };
  log(JSON.stringify(result, null, 2));
  log('Server counters include other clients and prefetch. Busy jobs include resource/IO waits; they are not CPU usage. This script does not change RENDER_CONCURRENCY.');
  log('Repeat the same area for cached delivery; choose a new area for rendering. No cache is cleared. Prefetch may continue after the HTTP batch ends.');
  return result;
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('node scripts/load-tiles.js [--url http://127.0.0.1:8080] [--z 16] [--x 60500] [--y 37950] [--width 8] [--height 8] [--concurrency 8] [--timeout 60]\nCoordinates are the top-left XYZ tile. Default: 64 unique tiles, eight requests at once. Ctrl+C stops the client; already accepted server work can finish.');
  else Promise.resolve().then(() => run(options(process.argv.slice(2)))).then(result => { if (result.failed) process.exitCode = 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { options, tilesFor, run };
