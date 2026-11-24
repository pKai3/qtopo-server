const path = require('node:path');
const fs = require('node:fs/promises');
const { readProcessMemory } = require('./process-memory');
const { fork } = require('node:child_process');
const { WorkQueue, PRIORITY } = require('./queue');
const L = require('./logger');
const { httpError, cachedRaster } = require('./utils');
const { createTimings } = require('./metrics');
const { forwardWorkerOutput } = require('./worker-output');
const { interestScore, rememberInterest } = require('./request-focus');
const { createRenderMemory } = require('./render-memory');
const { interestClients, summarizeClientQueues } = require('./client-queues');
function createRenderer(config, workerPath = path.join(__dirname, 'render_worker.js'), flyby, memoryOptions = {}, files) {
  const inflight = new Map(), workers = new Set(), idle = [];
  let cancelledQueued = 0, consecutiveFailures = 0, failures = 0, lastSuccessAt = null, lastFailureAt = null;
  function recordFailure(entry, error) {
    if (error.status === 503 || entry.outcomeRecorded) return;
    entry.outcomeRecorded = true; failures++; consecutiveFailures++; lastFailureAt = new Date().toISOString();
  }
  const timingsSummary = createTimings(['queueMs', 'firstTileMs', 'workerMs', 'resourceWaitMs', 'encodeMs', 'cpuMs']);
  const requestedTimings = createTimings(['queueMs', 'firstTileMs', 'workerMs', 'resourceWaitMs', 'encodeMs', 'cpuMs']);
  let spawned = 0, completed = 0, completedTiles = 0, lastRender, recycledForMemory = 0, releasedIdleForMemory = 0, peakWorkerRssBytes = 0, preemptedForMemory = 0, yieldedPrefetch = 0, yielding = false, releasingIdle = false;
  const workerMaxRssBytes = (config.renderWorkerMaxRssMb ?? 384) * 1024 ** 2;
  const memory = createRenderMemory({
    enabled: config.renderMemoryGuard ?? true,
    headroomBytes: (config.renderMemoryHeadroomMb ?? 512) * 1024 ** 2,
    headroomPercent: config.renderMemoryHeadroomPercent ?? 12.5,
    initialWorkerBytes: (config.renderMemoryInitialWorkerMb ?? 512) * 1024 ** 2,
    ...memoryOptions,
  });
  function canStart(next) {
    if (releasingIdle || yielding) return false;
    return memory.canStart({ active: [...queue.activeEntries].map(entry => entry.job), workers: [...workers], idle,
      job: next.job, reserveForeground: next.priority > PRIORITY.REQUEST && config.renderConcurrency > 1 });
  }
  const queue = new WorkQueue(config.renderConcurrency, config.renderQueueLimit, config.prefetchConcurrency, canStart);
  function yieldForRequests() {
    if (yielding || queue.closed) return;
    const requested = queue.waiting.filter(entry => entry.priority === PRIORITY.REQUEST), next = queue.next();
    // The preemption switch controls latency policy. Memory pressure can still
    // release speculative renders while the memory guard is enabled.
    if (!memory.pressure && config.prefetchPreempt === false) return;
    if (!memory.pressure && (!requested.length || (queue.active < queue.concurrency && canStart(next)))) return;
    const victims = [...workers].filter(w => w.task && w.task.job.priority > PRIORITY.REQUEST)
      .sort((a, b) => b.task.job.priority - a.task.job.priority || a.task.entry.ready.size - b.task.entry.ready.size ||
        interestScore(a.task.entry.interests) - interestScore(b.task.entry.interests))
      .slice(0, Math.max(1, requested.length));
    if (!victims.length) return;
    yielding = true;
    const releases = victims.map(worker => {
      const entry = worker.task.entry;
      // Detach before yielding: a newly requested sibling must get a fresh job,
      // never join the speculative job that is being cancelled.
      if (inflight.get(entry.key) === entry) inflight.delete(entry.key);
      if (requested.length) yieldedPrefetch++; else preemptedForMemory++;
      return finish(worker, httpError(requested.length ? 'Prefetch yielded to requested tiles' : 'Prefetch released for memory headroom', 503));
    });
    Promise.all(releases).finally(() => {
      yielding = false; memory.refresh(); queue.drain(); yieldForRequests();
    });
  }
  const memoryTimer = setInterval(() => {
    memory.refresh();
    if (!memory.stats().enabled) return;
    for (const worker of workers) {
      try {
        Object.assign(worker, readProcessMemory(worker.child.pid));
        worker.peakRssBytes = Math.max(worker.peakRssBytes || 0, worker.rssBytes);
        worker.peakFootprintBytes = Math.max(worker.peakFootprintBytes || 0, worker.footprintBytes);
      } catch {} // An exiting worker is still charged by the cgroup until gone.
    }
    const next = queue.next();
    const blocked = next && !canStart(next);
    if (!releasingIdle && idle.length && queue.active === [...workers].filter(w => w.task).length &&
        ((blocked && (!queue.active || (next.priority === PRIORITY.REQUEST && idle.length > 1))) || memory.pressure)) {
      // Release one retained map at a time, rather than repeatedly destroying
      // the whole warm pool just because speculative work wants more room.
      releasingIdle = true; releasedIdleForMemory++;
      const victim = [...idle].sort((a, b) => b.footprintBytes - a.footprintBytes)[0];
      discard(victim).finally(() => { releasingIdle = false; memory.refresh(); queue.drain(); yieldForRequests(); });
    } else { queue.drain(); yieldForRequests(); }
  }, 100);
  memoryTimer.unref();
  function ready(entry, file) {
    if (!entry.outputs.has(file)) return;
    entry.ready.add(file);
    entry.waiters.get(file)?.resolve(file);
  }
  function discard(worker) {
    clearTimeout(worker.idleTimer);
    workers.delete(worker);
    const index = idle.indexOf(worker); if (index !== -1) idle.splice(index, 1);
    worker.child.kill('SIGKILL');
    return worker.exited;
  }
  async function finish(worker, error, timings, rssBytes = 0, peakRssBytes = 0, footprintBytes = rssBytes, peakFootprintBytes = peakRssBytes) {
    const task = worker.task;
    if (!task) return;
    worker.task = null; task.entry.worker = null; clearTimeout(task.timer);
    try {
      if (error) throw error;
      for (const file of task.entry.outputs) {
        if (!(await cachedRaster(file, config.rasterTTL, config.emptyTTL))?.size) throw httpError('Renderer produced no output');
      }
      completed++; completedTiles += task.entry.outputs.size;
      task.entry.outcomeRecorded = true;
      consecutiveFailures = 0; lastSuccessAt = new Date().toISOString();
      for (const file of task.entry.outputs) ready(task.entry, file);
      if (timings) {
        const priority = ['requested', 'neighbour', 'zoom'][task.job.priority ?? PRIORITY.REQUEST];
        lastRender = { z: task.job.z, x: task.job.x, y: task.job.y, priority, tiles: task.entry.outputs.size,
          queueMs: task.queueMs, firstTileMs: task.firstTileMs ?? Date.now() - task.started, workerMs: Date.now() - task.started, ...timings };
        timingsSummary.record(lastRender);
        if (priority === 'requested') requestedTimings.record({ ...lastRender, queueMs: Math.max(0, task.started - task.entry.requestedAt) });
        L.log('TIMING', `${priority} ${task.job.z}/${task.job.x}/${task.job.y} (${lastRender.tiles} tiles): queue ${lastRender.queueMs}ms, first tile ${lastRender.firstTileMs}ms, worker ${lastRender.workerMs}ms, resources ${timings.resourceWaitMs}ms, PNG ${timings.encodeMs}ms, CPU ${timings.cpuMs}ms`);
      }
      worker.peakRssBytes = Math.max(worker.peakRssBytes || 0, peakRssBytes, rssBytes);
      peakWorkerRssBytes = Math.max(peakWorkerRssBytes, worker.peakRssBytes);
      worker.rssBytes = rssBytes || worker.rssBytes || 0;
      worker.footprintBytes = footprintBytes || worker.footprintBytes || worker.rssBytes;
      worker.peakFootprintBytes = Math.max(worker.peakFootprintBytes || 0, peakFootprintBytes, worker.footprintBytes);
      memory.observePeak(worker.peakFootprintBytes, task.job);
      memory.refresh();
      const oversized = worker.rssBytes >= workerMaxRssBytes;
      if (oversized) recycledForMemory++;
      if (queue.closed || ++worker.jobs >= 128 || oversized || memory.pressure) {
        // Do not start the replacement until the old process has released its
        // memory. Overlapping old/new pools can exceed the container's cap.
        await discard(worker);
      }
      else if (workers.has(worker)) {
        idle.push(worker);
        worker.idleTimer = setTimeout(() => discard(worker), 120000); worker.idleTimer.unref();
      }
      task.resolve();
    } catch (err) {
      recordFailure(task.entry, err);
      await discard(worker); task.reject(err);
    }
  }
  function acquire() {
    if (idle.length) {
      const worker = idle.pop(); clearTimeout(worker.idleTimer); return worker;
    }
    const child = fork(workerPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    const worker = { child, exited, jobs: 0, task: null };
    forwardWorkerOutput(child.stdout, line => L.log('NATIVE', `worker ${child.pid}: ${line}`));
    forwardWorkerOutput(child.stderr, line => L.err('NATIVE', `worker ${child.pid}: ${line}`));
    workers.add(worker); spawned++;
    child.on('message', message => {
      if (message.error) finish(worker, httpError(message.error));
      else if (message.done) finish(worker, null, message.timings, message.rssBytes, message.peakRssBytes, message.footprintBytes, message.peakFootprintBytes);
      else if (message.preview && worker.task?.entry.outputs.has(message.preview.outPath)) {
        flyby?.publish(message.preview.image, worker.task.entry.job);
      }
      else if (message.tileReady && worker.task?.entry.outputs.has(message.tileReady)) {
        files?.written?.(message.bytes || 0);
        worker.task.firstTileMs ??= Date.now() - worker.task.started;
        ready(worker.task.entry, message.tileReady);
      }
    });
    child.on('error', err => { finish(worker, err); discard(worker); });
    child.on('exit', (code, signal) => {
      finish(worker, httpError(`Renderer exited ${signal || code}`)); discard(worker);
    });
    return worker;
  }
  function render(job, interest) {
    if (interest?.signal?.aborted) return Promise.reject(interest.signal.reason);
    const key = job.renderKey || job.outPath;
    let entry = inflight.get(key);
    if (!entry) {
      entry = { key, job, outputs: new Set((job.outputs || [job]).map(t => t.outPath)), ready: new Set(), waiters: new Map(), requested: new Set(), interests: new Map(), consumers: new Set(), controller: new AbortController(), started: false, untracked: false };
      if (interest) rememberInterest(entry.interests, { ...interest, priority: job.priority ?? PRIORITY.REQUEST });
      inflight.set(key, entry);
      const queued = Date.now();
      queue.run(async () => {
        entry.controller.signal.throwIfAborted();
        entry.started = true;
        const leases = files?.scope();
        try {
          for (const file of [...entry.outputs, entry.job.inputPath, entry.job.backgroundPath, ...(entry.job.images || []).map(image => image.path)].filter(Boolean)) await leases?.hold(file);
          const started = Date.now(), queueMs = started - queued;
          const cached = await Promise.all([...entry.outputs].map(file => cachedRaster(file, config.rasterTTL, config.emptyTTL)));
          if (cached.every(file => file?.size)) { for (const file of entry.outputs) ready(entry, file); return; }
          await Promise.all([...entry.outputs].map(file => fs.mkdir(path.dirname(file), { recursive: true })));
          if (queue.closed) throw httpError('Server shutting down', 503);
          const worker = acquire(); entry.worker = worker;
          worker.peakRssBytes = worker.rssBytes || 0;
          worker.peakFootprintBytes = worker.footprintBytes ?? worker.rssBytes ?? 0;
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(worker, httpError('Render timed out', 504)), config.renderTimeoutMs);
            worker.task = { resolve, reject, timer, job: entry.job, entry, started, queueMs };
            const resourceMaxAgeMs = Math.min(60000, config.vectorTTL || Infinity, config.resourceTTL || Infinity, config.emptyTTL || Infinity);
            worker.child.send({ ...entry.job, preview: flyby?.reserve() || false, requested: [...entry.requested], pngCompression: config.pngCompression,
              timeoutMs: config.upstreamTimeoutMs, resourceMaxAgeMs }, err => { if (err) finish(worker, err); });
          });
        } finally { leases?.close(); }
      }, { priority: job.priority, key, job: entry.job, rank: job.rank, score: () => interestScore(entry.interests, entry.job.priority ?? PRIORITY.REQUEST),
        clients: () => interestClients(entry.interests), signal: entry.controller.signal }).catch(err => {
        recordFailure(entry, err);
        for (const [file, waiter] of entry.waiters) if (!entry.ready.has(file)) waiter.reject(err);
        if (entry.ready.size && err.status !== 503) L.err('RDR', `Render failed after saving ${entry.ready.size} tile(s): ${err.message}`);
      }).finally(() => { if (inflight.get(key) === entry) inflight.delete(key); });
    }
    if (!interest?.signal) entry.untracked = true;
    entry.job.priority = Math.min(entry.job.priority ?? PRIORITY.REQUEST, job.priority ?? PRIORITY.REQUEST);
    entry.job.rank = Math.max(entry.job.rank || 0, job.rank || 0);
    if (interest) rememberInterest(entry.interests, { ...interest,
      priority: Math.min(entry.interests.get(interest.key)?.priority ?? Infinity, job.priority ?? PRIORITY.REQUEST) });
    if ((job.priority ?? PRIORITY.REQUEST) === PRIORITY.REQUEST) { entry.requested.add(job.outPath); entry.requestedAt ??= Date.now(); }
    queue.promote(key, job.priority ?? PRIORITY.REQUEST, job.rank);
    const worker = entry.worker;
    if (worker) worker.child.send({ promote: { outPath: job.outPath, priority: job.priority ?? PRIORITY.REQUEST } }, err => {
      if (err) finish(worker, err);
    });
    if (!entry.outputs.has(job.outPath)) return Promise.reject(httpError('Render grid changed; please retry'));
    let waiter = entry.waiters.get(job.outPath);
    if (!waiter) {
      waiter = {};
      waiter.promise = new Promise((resolve, reject) => Object.assign(waiter, { resolve, reject }));
      entry.waiters.set(job.outPath, waiter);
      if (entry.ready.has(job.outPath)) waiter.resolve(job.outPath);
    }
    yieldForRequests();
    if (!interest?.signal) return waiter.promise;
    // Each HTTP request owns its own subscription, even when IP, tile and
    // metatile match. Abandonment of one subscription never rejects another.
    const consumer = {};
    entry.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; entry.consumers.delete(consumer);
        interest.signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => {
        finish(interest.signal.reason);
        if (!entry.started && !entry.untracked && !entry.consumers.size) {
          // Detach before cancelling, so an immediate retry starts fresh.
          if (inflight.get(key) === entry) inflight.delete(key);
          cancelledQueued++;
          entry.controller.abort(httpError('Queued render has no remaining requests', 503));
        }
      };
      interest.signal.addEventListener('abort', abort, { once: true });
      waiter.promise.then(result => finish(null, result), finish);
      if (interest.signal.aborted) abort();
    });
  }
  return {
    render,
    get clientQueues() { return summarizeClientQueues([
      ...[...queue.activeEntries].map(entry => ({ state: 'rendering', priority: entry.priority, clients: entry.clients() })),
      ...queue.waiting.map(entry => ({ state: 'waiting', priority: entry.priority, clients: entry.clients() })),
    ]); },
    get stats() { return { ...queue.stats, memory: { ...memory.stats([...workers]), limited: !!queue.waiting.length && memory.stats().limited,
      workerEstimateBasis: 'anonymous resident memory',
      workerFootprintBytes: [...workers].reduce((sum, w) => sum + (w.footprintBytes ?? w.rssBytes ?? 0), 0),
      parentRssBytes: process.memoryUsage.rss(), workerRssBytes: [...workers].reduce((sum, w) => sum + (w.rssBytes || 0), 0),
      idleRssBytes: idle.reduce((sum, w) => sum + (w.rssBytes || 0), 0), releasedIdleWorkers: releasedIdleForMemory },
      workers: workers.size, idleWorkers: idle.length, spawned, yieldedPrefetch, preemptedForMemory, completed, completedTiles, cancelledQueued,
      failures, consecutiveFailures, lastSuccessAt, lastFailureAt,
      recycledForMemory, peakWorkerRssBytes, workerMaxRssBytes, lastRender, requestedTimings: requestedTimings.stats, timings: timingsSummary.stats }; },
    close() {
      clearInterval(memoryTimer);
      queue.close();
      for (const worker of workers) { finish(worker, httpError('Server shutting down', 503)); discard(worker); }
    },
  };
}
module.exports = { createRenderer };
