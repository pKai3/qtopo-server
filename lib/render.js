const path = require('node:path');
const fs = require('node:fs/promises');
const { fork } = require('node:child_process');
const { WorkQueue, PRIORITY } = require('./queue');
const L = require('./logger');
const { httpError, cachedRaster } = require('./utils');
const { createTimings } = require('./metrics');
const { forwardWorkerOutput } = require('./worker-output');
const { interestScore, rememberInterest } = require('./request-focus');
function createRenderer(config, workerPath = path.join(__dirname, 'render_worker.js')) {
  const queue = new WorkQueue(config.renderConcurrency, config.renderQueueLimit, config.prefetchConcurrency);
  const inflight = new Map(), workers = new Set(), idle = [];
  const timingsSummary = createTimings(['queueMs', 'firstTileMs', 'workerMs', 'resourceWaitMs', 'encodeMs', 'cpuMs']);
  let spawned = 0, completed = 0, completedTiles = 0, lastRender, recycledForMemory = 0, peakWorkerRssBytes = 0;
  const workerMaxRssBytes = (config.renderWorkerMaxRssMb ?? 384) * 1024 ** 2;
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
  async function finish(worker, error, timings, rssBytes = 0) {
    const task = worker.task;
    if (!task) return;
    worker.task = null; task.entry.worker = null; clearTimeout(task.timer);
    try {
      if (error) throw error;
      for (const file of task.entry.outputs) {
        if (!(await cachedRaster(file, config.rasterTTL, config.emptyTTL))?.size) throw httpError('Renderer produced no output');
      }
      completed++; completedTiles += task.entry.outputs.size;
      for (const file of task.entry.outputs) ready(task.entry, file);
      if (timings) {
        const priority = ['requested', 'neighbour', 'zoom'][task.job.priority ?? PRIORITY.REQUEST];
        lastRender = { z: task.job.z, x: task.job.x, y: task.job.y, priority, tiles: task.entry.outputs.size,
          queueMs: task.queueMs, firstTileMs: task.firstTileMs ?? Date.now() - task.started, workerMs: Date.now() - task.started, ...timings };
        timingsSummary.record(lastRender);
        L.log('TIMING', `${priority} ${task.job.z}/${task.job.x}/${task.job.y} (${lastRender.tiles} tiles): queue ${lastRender.queueMs}ms, first tile ${lastRender.firstTileMs}ms, worker ${lastRender.workerMs}ms, resources ${timings.resourceWaitMs}ms, PNG ${timings.encodeMs}ms, CPU ${timings.cpuMs}ms`);
      }
      peakWorkerRssBytes = Math.max(peakWorkerRssBytes, rssBytes);
      const oversized = rssBytes >= workerMaxRssBytes;
      if (oversized) recycledForMemory++;
      if (queue.closed || ++worker.jobs >= 128 || oversized) {
        // Do not start the replacement until the old process has released its
        // memory. Overlapping old/new pools can exceed the container's cap.
        await discard(worker);
      }
      else if (workers.has(worker)) {
        idle.push(worker);
        worker.idleTimer = setTimeout(() => discard(worker), 120000); worker.idleTimer.unref();
      }
      task.resolve();
    } catch (err) { discard(worker); task.reject(err); }
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
      else if (message.done) finish(worker, null, message.timings, message.rssBytes);
      else if (message.tileReady && worker.task?.entry.outputs.has(message.tileReady)) {
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
    const key = job.renderKey || job.outPath;
    let entry = inflight.get(key);
    if (!entry) {
      entry = { job, outputs: new Set((job.outputs || [job]).map(t => t.outPath)), ready: new Set(), waiters: new Map(), requested: new Set(), interests: new Map() };
      if (interest) rememberInterest(entry.interests, { ...interest, priority: job.priority ?? PRIORITY.REQUEST });
      inflight.set(key, entry);
      const queued = Date.now();
      queue.run(async () => {
        const started = Date.now(), queueMs = started - queued;
        const cached = await Promise.all([...entry.outputs].map(file => cachedRaster(file, config.rasterTTL, config.emptyTTL)));
        if (cached.every(file => file?.size)) { for (const file of entry.outputs) ready(entry, file); return; }
        await Promise.all([...entry.outputs].map(file => fs.mkdir(path.dirname(file), { recursive: true })));
        if (queue.closed) throw httpError('Server shutting down', 503);
        const worker = acquire(); entry.worker = worker;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(worker, httpError('Render timed out', 504)), config.renderTimeoutMs);
          worker.task = { resolve, reject, timer, job: entry.job, entry, started, queueMs };
          const resourceMaxAgeMs = Math.min(60000, config.vectorTTL || Infinity, config.resourceTTL || Infinity, config.emptyTTL || Infinity);
          worker.child.send({ ...entry.job, requested: [...entry.requested], pngCompression: config.pngCompression,
            timeoutMs: config.upstreamTimeoutMs, resourceMaxAgeMs }, err => { if (err) finish(worker, err); });
        });
      }, { priority: job.priority, key, rank: job.rank, score: () => interestScore(entry.interests, entry.job.priority ?? PRIORITY.REQUEST) }).catch(err => {
        for (const [file, waiter] of entry.waiters) if (!entry.ready.has(file)) waiter.reject(err);
        if (entry.ready.size) L.err('RDR', `Render failed after saving ${entry.ready.size} tile(s): ${err.message}`);
      }).finally(() => inflight.delete(key));
    }
    entry.job.priority = Math.min(entry.job.priority ?? PRIORITY.REQUEST, job.priority ?? PRIORITY.REQUEST);
    entry.job.rank = Math.max(entry.job.rank || 0, job.rank || 0);
    if (interest) rememberInterest(entry.interests, { ...interest,
      priority: Math.min(entry.interests.get(interest.key)?.priority ?? Infinity, job.priority ?? PRIORITY.REQUEST) });
    if ((job.priority ?? PRIORITY.REQUEST) === PRIORITY.REQUEST) entry.requested.add(job.outPath);
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
    return waiter.promise;
  }
  return {
    render,
    get stats() { return { ...queue.stats, workers: workers.size, spawned, completed, completedTiles, recycledForMemory, peakWorkerRssBytes, workerMaxRssBytes, lastRender, timings: timingsSummary.stats }; },
    close() {
      queue.close();
      for (const worker of workers) { finish(worker, httpError('Server shutting down', 503)); discard(worker); }
    },
  };
}
module.exports = { createRenderer };
