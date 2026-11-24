'use strict';
// Run inside the target container. stdout is the live viewer's NDJSON event feed.
const fs = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const quantile = (items, q) => items.length ? [...items].sort((a, b) => a - b)[Math.ceil(items.length * q) - 1] : null;
const kv = text => Object.fromEntries(text.trim().split('\n').map(line => {
  const [key, value] = line.trim().split(/\s+/); return [key.replace(':', ''), Number(value)];
}));

function prepareTrace(input, workload) {
  const trace = structuredClone(input);
  if (workload === 'synthetic') {
    for (const key of ['sustained', 'jumps']) {
      if (!Array.isArray(trace[key]) || !trace[key].length) throw Error('Missing synthetic routes: ' + key);
      for (const [profile, z, x, y] of trace[key]) {
        validateTile({profile, z, x, y});
        validateTile({profile, z, x:x+8, y:y+8});
      }
    }
  } else {
    if (!['clock', 'paced', 'partial'].includes(workload) || !Array.isArray(trace.requests) || !trace.requests.length)
      throw Error('Missing human trace or invalid replay mode');
    if (!/^[a-z0-9-]+$/.test(trace.kind)) throw Error('Invalid trace kind');
    if (trace.coordinates === 'relative') {
      validateTile({profile:'mobile', z:trace.baseZoom, ...trace.anchor});
      for (const tile of trace.requests) {
        if (tile.z < trace.baseZoom) throw Error('Tile zoom precedes relative anchor');
        const scale = 2 ** (tile.z - trace.baseZoom);
        tile.x += trace.anchor.x * scale;
        tile.y += trace.anchor.y * scale;
      }
    }
    let lastT = -1, lastGroup = -1;
    for (const tile of trace.requests) {
      validateTile(tile);
      if (!Number.isFinite(tile.t) || tile.t < 0 || tile.t < lastT || !Number.isInteger(tile.group) || tile.group < 0 || tile.group < lastGroup)
        throw Error('Trace times and groups must be ordered and nonnegative');
      if (tile.outcome === 'abandoned' && (!Number.isFinite(tile.durationMs) || tile.durationMs < 0))
        throw Error('Cancelled request needs a nonnegative duration');
      lastT = tile.t; lastGroup = tile.group;
    }
    if (lastT > 420000) throw Error('Trace exceeds seven minutes; split it before replay');
    if (workload === 'partial') {
      trace.replayPolicy = {readyFraction:.75, minPauseMs:100, maxPauseMs:1500, ...trace.replayPolicy};
      const p = trace.replayPolicy;
      if (![p.readyFraction,p.minPauseMs,p.maxPauseMs].every(Number.isFinite) ||
          !(p.readyFraction > 0 && p.readyFraction <= 1 && p.minPauseMs >= 0 && p.maxPauseMs >= p.minPauseMs && p.maxPauseMs <= 5000))
        throw Error('Invalid partial-delivery replay policy');
    }
  }
  return trace;
}
function validateTile({profile,z,x,y}) {
  if (!/^[a-z0-9-]+$/.test(profile) || !Number.isInteger(z) || z < 0 || z > 19 ||
      !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 2**z || y >= 2**z)
    throw Error('Invalid tile coordinate or profile');
}

async function main([output, run, workload, tracePath, expectedPath]) {
  if (output === '--validate') {
    prepareTrace(JSON.parse(await fs.readFile(workload, 'utf8')), run);
    console.log('Trace validated'); return;
  }
  if (!output || !/^[a-z0-9-]+$/.test(run) || !['synthetic', 'clock', 'paced', 'partial'].includes(workload))
    throw Error('Usage: node run.js REPORT RUN-ID synthetic|clock|paced|partial TRACE.json EXPECTED.json');
  const origin = 'http://127.0.0.1:8080';
  const trace = prepareTrace(JSON.parse(await fs.readFile(tracePath, 'utf8')), workload);
  if (!expectedPath) throw Error('Use tower-run.sh to capture current resource settings first');
  const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'));
  if (!(expected.memoryBytes > 0 && Number.isFinite(expected.hostMinGiB) && expected.hostMinGiB >= 0))
    throw Error('Invalid resource expectations');
  const tilePixels = expected.settings.tilePx;
  const plannedRequests = workload === 'synthetic' ? trace.sustained.length * 24 + trace.jumps.length * 12 + 12 + 88 : trace.requests.length;
  const report = { run, workload, started: new Date().toISOString(), requests: [], phases: [], samples: [] };
  if (workload === 'partial') {
    report.replayPolicy = trace.replayPolicy;
  }
  const stop = new AbortController();
  let finished = false, monitor, phase = 'startup', nextId = 0, failures = 0;
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const emit = data => console.log(JSON.stringify({ run, t: Math.round(now()), at: new Date().toISOString(), ...data }));
  const status = async () => {
    const response = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw Error('Status HTTP ' + response.status);
    return response.json();
  };
  const busy = s => s.renderer.active + s.renderer.queued + s.requests.active +
    (s.prefetch.active || 0) + (s.prefetch.queued || 0) + (s.prefetch.tracked || 0) +
    s.cache.downloads.active + s.cache.downloads.queued;
  async function drain(timeout = 90000) {
    const start = now();
    while (now() - start < timeout) {
      stop.signal.throwIfAborted();
      const s = await status();
      if (!busy(s)) return { ms: now() - start, status: s };
      await sleep(500);
    }
    throw Error('Background work did not drain within 90 seconds');
  }
  function delta(a, b) {
    const result = {};
    for (const k of ['completed', 'errors', 'disconnected', 'hits', 'misses', 'prefetchUsed'])
      result[k] = (b.requests[k] || 0) - (a.requests[k] || 0);
    for (const k of ['completed', 'spawned', 'yieldedPrefetch', 'cancelledObsolete', 'recycledForMemory'])
      result['render_' + k] = (b.renderer[k] || 0) - (a.renderer[k] || 0);
    return result;
  }
  function plan(tiles, group) {
    const records = tiles.map(tile => ({ ...tile, id: nextId++, phase, group }));
    emit({ event: 'plan', phase, group, tiles: records });
    return records;
  }
  async function request(tile, controller) {
    stop.signal.throwIfAborted();
    const start = now();
    const rec = { ...tile, startedMs: start };
    report.requests.push(rec);
    emit({ event: 'tile', id: tile.id, state: 'sent' });
    try {
      const response = await fetch(`${origin}/${tile.profile}/${tile.z}/${tile.x}/${tile.y}.png`, {
        signal: AbortSignal.any([stop.signal, controller?.signal || new AbortController().signal, AbortSignal.timeout(45000)])
      });
      rec.headersMs = now() - start;
      rec.status = response.status;
      emit({ event: 'tile', id: tile.id, state: 'headers', status: response.status });
      const bytes = Buffer.from(await response.arrayBuffer());
      rec.bytes = bytes.length;
      if (response.status !== 200) throw Error('Tile HTTP ' + response.status);
      if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          bytes.readUInt32BE(16) !== tilePixels || bytes.readUInt32BE(20) !== tilePixels) throw Error('Invalid PNG tile');
      rec.ok = true;
    } catch (error) {
      if (controller?.signal.aborted && !stop.signal.aborted) rec.abandoned = true;
      else rec.error = error.message;
    }
    rec.ms = now() - start;
    emit({ event: 'tile', id: tile.id, state: rec.ok ? 'received' : rec.abandoned ? 'abandoned' : 'error', ms: rec.ms, error: rec.error });
    return rec;
  }
  async function section(name, body) {
    phase = name;
    const before = await status(), start = now(), first = report.requests.length;
    emit({ event: 'phase', phase, state: 'running' });
    const extra = await body() || {};
    const foregroundMs = now() - start;
    emit({ event: 'phase', phase, state: 'draining', foregroundMs });
    const drained = await drain();
    const requests = report.requests.slice(first);
    const completed = requests.filter(r => r.ok).map(r => r.ms);
    const result = { name, foregroundMs, drainMs: drained.ms, requests: requests.length,
      medianMs: quantile(completed, .5), p95Ms: quantile(completed, .95),
      errors: requests.filter(r => r.error).length, abandoned: requests.filter(r => r.abandoned).length,
      delta: delta(before, drained.status), ...extra };
    report.phases.push(result);
    emit({ event: 'phase', phase, state: 'complete', result });
    if (result.errors) throw Error(`${name}: ${result.errors} requests failed`);
    return result;
  }
  try {
    const before = (await drain()).status;
    report.before = before;
    const initialEvents = kv(await fs.readFile('/sys/fs/cgroup/memory.events', 'utf8'));
    report.initialMemoryEvents = initialEvents;
    report.initialCpu = kv(await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8'));
    report.limit = Number(await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8'));
    report.expected = expected;
    if (report.limit !== expected.memoryBytes) throw Error('Container memory cap changed');
    for (const [key, value] of Object.entries(expected.settings)) {
      if (!['prefetchRadius', 'prefetchZoom', 'prefetchPreempt'].includes(key) && before.settings[key] !== value)
        throw Error('Unexpected configuration change: ' + key);
    }
    report.styles = {};
    for (const id of ['readable', 'mobile-3x']) {
      try {
        const doc = JSON.parse(await fs.readFile('/data/styles/' + id + '.json'));
        report.styles[id] = crypto.createHash('sha256').update(JSON.stringify(doc.styles)).digest('hex');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        report.styles[id] = null; // Bundled defaults may have no live override.
      }
    }
    emit({ event: 'start', workload, plannedRequests, replayPolicy: report.replayPolicy, settings: before.settings, revision: before.revision, styles: report.styles });
    monitor = (async () => {
      while (!finished) {
        const start = now();
        try {
          const [s, memory, events, host] = await Promise.all([status(),
            fs.readFile('/sys/fs/cgroup/memory.stat', 'utf8'), fs.readFile('/sys/fs/cgroup/memory.events', 'utf8'), fs.readFile('/proc/meminfo', 'utf8')]);
          const m = kv(memory), e = kv(events), h = kv(host);
          const sample = { t: Math.round(start), phase, healthMs: now() - start, anon: m.anon,
            current: s.renderer.memory.currentBytes, working: s.renderer.memory.workingBytes,
            hostAvailable: h.MemAvailable * 1024, active: s.renderer.active, queued: s.renderer.queued,
            prefetchQueued: s.prefetch.queued || 0, downloadActive: s.cache.downloads.active,
            downloadQueued: s.cache.downloads.queued, limited: s.renderer.memory.limited };
          report.samples.push(sample);
          emit({ event: 'sample', ...sample });
          if (s.startedAt !== before.startedAt) throw Error('Container restarted');
          if (e.oom > initialEvents.oom || e.oom_kill > initialEvents.oom_kill) throw Error('Container memory allocation failure');
          if (h.MemAvailable * 1024 < expected.hostMinGiB * 1024 ** 3) throw Error('Host available RAM below configured safety margin');
          if (now() > 480000) throw Error('Eight-minute run safety limit');
          failures = 0;
        } catch (error) {
          if (++failures >= 2 || /restarted|allocation|available|safety/.test(error.message)) {
            report.safetyStop = error.message; stop.abort(error); emit({ event: 'safety-stop', reason: error.message }); return;
          }
        }
        await sleep(500);
      }
    })();
    if (workload === 'synthetic') {
      report.trace = trace.name;
      const make = (route, count) => Array.from({ length: count }, (_, i) => ({ profile: route[0], z: route[1], x: route[2] + (i % 5) * 2, y: route[3] + Math.floor(i / 5) * 2 }));
      await section('fresh-batches', async () => {
        for (const [i, route] of trace.sustained.entries()) await Promise.all(plan(make(route, 24), i).map(t => request(t)));
      });
      await section('rapid-jumps', async () => {
        const pending = []; let previous, final;
        for (const [i, route] of trace.jumps.entries()) {
          if (previous) previous.abort(new Error('Viewport replaced'));
          previous = new AbortController();
          const start = now();
          const tasks = plan(make(route, 12), i).map(t => request(t, previous));
          pending.push(...tasks);
          if (i === trace.jumps.length - 1) {
            const results = await Promise.all(tasks);
            final = { finalViewMs: now() - start, finalViewFirstMs: Math.min(...results.filter(r => r.ok).map(r => r.ms)) };
          } else await sleep(1500);
        }
        await Promise.all(pending); return final;
      });
      await section('cached-repeat', () => Promise.all(plan(make(trace.jumps.at(-1), 12), 0).map(t => request(t))).then(() => ({})));
      await section('steady-pan', async () => {
        // Start with a 6x4 view; each step exposes two new columns eastward.
        for (let step = 0; step < 9; step++) {
          const width = step ? 2 : 6, x0 = 60500 + (step ? 6 + (step - 1) * 2 : 0);
          const tiles = Array.from({ length: width * 4 }, (_, i) => ({ profile: 'mobile', z: 16, x: x0 + i % width, y: 37880 + Math.floor(i / width) }));
          await Promise.all(plan(tiles, step).map(t => request(t)));
          if (step < 8) await sleep(350);
        }
      });
    } else {
      report.trace = { kind: trace.kind, durationMs: trace.durationMs, groups: trace.groups, recordedAt: trace.recordedAt };
      await section(trace.kind + '-' + workload, async () => {
        if (workload === 'clock') {
          const start = now(), pending = [];
          for (const tile of trace.requests) {
            await sleep(start + tile.t - now());
            stop.signal.throwIfAborted();
            const planned = plan([tile], tile.group)[0];
            const controller = new AbortController();
            const timer = tile.outcome === 'abandoned' ? setTimeout(() => controller.abort(), tile.durationMs) : null;
            pending.push(request(planned, controller).finally(() => clearTimeout(timer)));
          }
          await Promise.all(pending);
        } else if (workload === 'paced') {
          // Deliberately a model: original request bursts, wait for delivery, then 300ms.
          const groups = Map.groupBy(trace.requests, t => t.group);
          for (const [group, tiles] of groups) {
            await Promise.all(plan(tiles, group).map(t => request(t)));
            if (group !== trace.requests.at(-1).group) await sleep(300);
          }
        } else {
          // Sensitivity model, not an inferred viewport: preserve intra-burst arrivals,
          // move before every response finishes, and retain recorded cancellations.
          const p = report.replayPolicy, pending = [], moves = [], start = now();
          const groups = Map.groupBy(trace.requests, t => t.group);
          for (const [group, tiles] of groups) {
            stop.signal.throwIfAborted();
            const began = now(), recordedStart = tiles[0].t;
            let received = 0;
            for (const tile of tiles) {
              await sleep(began + tile.t - recordedStart - now());
              stop.signal.throwIfAborted();
              const planned = plan([tile], group)[0], controller = new AbortController();
              const timer = tile.outcome === 'abandoned' ? setTimeout(() => controller.abort(), tile.durationMs) : null;
              const task = request(planned, controller).then(r => { if (r.ok) received++; return r; }).finally(() => clearTimeout(timer));
              pending.push(task);
            }
            const sentAt = now(), needed = Math.ceil(tiles.length * p.readyFraction);
            while (now() - sentAt < p.minPauseMs || received < needed && now() - sentAt < p.maxPauseMs) {
              stop.signal.throwIfAborted();
              await sleep(20);
            }
            const move = { group, elapsedMs: now() - began, received, total: tiles.length, timedOut: received < needed };
            moves.push(move);
            emit({ event: 'move', phase, ...move });
          }
          const movementMs = now() - start;
          await Promise.all(pending);
          return { movementMs, outstandingTailMs: now() - start - movementMs, moves, replayPolicy: p };
        }
      });
    }
    report.after = await status();
    report.finalMemoryEvents = kv(await fs.readFile('/sys/fs/cgroup/memory.events', 'utf8'));
    report.finalCpu = kv(await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8'));
    report.summary = { peakWorking: Math.max(...report.samples.map(s => s.working)), peakCurrent: Math.max(...report.samples.map(s => s.current)),
      minHostAvailable: Math.min(...report.samples.map(s => s.hostAvailable)), peakWorkers: Math.max(...report.samples.map(s => s.active)),
      errors: report.requests.filter(r => r.error).length, abandoned: report.requests.filter(r => r.abandoned).length };
    emit({ event: 'complete', summary: report.summary, phases: report.phases });
  } catch (error) {
    report.error = error.stack; stop.abort(error); process.exitCode = 1; emit({ event: 'failed', error: error.message });
  } finally {
    finished = true; await monitor; report.finished = new Date().toISOString();
    await fs.writeFile(output, JSON.stringify(report, null, 2));
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { quantile, kv, prepareTrace };
