const path = require('node:path');
const fs = require('node:fs/promises');
const { fork } = require('node:child_process');
const { WorkQueue, PRIORITY } = require('./queue');
const L = require('./logger');
const { httpError, cachedRaster } = require('./utils');
function createRenderer(config, workerPath = path.join(__dirname, 'render_worker.js')) {
  const queue = new WorkQueue(config.renderConcurrency, config.renderQueueLimit, config.prefetchConcurrency);
  const inflight = new Map(), workers = new Set(), idle = [];
  let spawned = 0, completed = 0, lastRender;
  function discard(worker) {
    clearTimeout(worker.idleTimer);
    workers.delete(worker);
    const index = idle.indexOf(worker); if (index !== -1) idle.splice(index, 1);
    worker.child.kill('SIGKILL');
  }
  async function finish(worker, error, timings) {
    const task = worker.task;
    if (!task) return;
    worker.task = null; clearTimeout(task.timer);
    try {
      if (error) throw error;
      if (!(await cachedRaster(task.job.outPath, config.rasterTTL, config.emptyTTL))?.size) throw httpError('Renderer produced no output');
      completed++;
      if (timings) {
        const priority = ['requested', 'neighbour', 'zoom'][task.job.priority ?? PRIORITY.REQUEST];
        lastRender = { z: task.job.z, x: task.job.x, y: task.job.y, priority, queueMs: task.queueMs, workerMs: Date.now() - task.started, ...timings };
        L.log('TIMING', `${priority} ${task.job.z}/${task.job.x}/${task.job.y}: queue ${lastRender.queueMs}ms, worker ${lastRender.workerMs}ms, resources ${timings.resourceWaitMs}ms, PNG ${timings.encodeMs}ms, CPU ${timings.cpuMs}ms`);
      }
      if (queue.closed || ++worker.jobs >= 128) discard(worker);
      else if (workers.has(worker)) {
        idle.push(worker);
        worker.idleTimer = setTimeout(() => discard(worker), 120000); worker.idleTimer.unref();
      }
      task.resolve(task.job.outPath);
    } catch (err) { discard(worker); task.reject(err); }
  }
  function acquire() {
    if (idle.length) {
      const worker = idle.pop(); clearTimeout(worker.idleTimer); return worker;
    }
    const child = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const worker = { child, jobs: 0, task: null };
    workers.add(worker); spawned++;
    child.on('message', message => {
      if (message.error) finish(worker, httpError(message.error));
      else if (message.done) finish(worker, null, message.timings);
    });
    child.on('error', err => { finish(worker, err); discard(worker); });
    child.on('exit', (code, signal) => {
      finish(worker, httpError(`Renderer exited ${signal || code}`)); discard(worker);
    });
    return worker;
  }
  function render(job) {
    if (inflight.has(job.outPath)) {
      queue.promote(job.outPath, job.priority ?? PRIORITY.REQUEST, job.rank);
      return inflight.get(job.outPath);
    }
    const queued = Date.now();
    const p = queue.run(async () => {
      const started = Date.now(), queueMs = started - queued;
      if ((await cachedRaster(job.outPath, config.rasterTTL, config.emptyTTL))?.size) return job.outPath;
      await fs.mkdir(path.dirname(job.outPath), { recursive: true });
      if (queue.closed) throw httpError('Server shutting down', 503);
      const worker = acquire();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(worker, httpError('Render timed out', 504)), config.renderTimeoutMs);
        worker.task = { resolve, reject, timer, job, started, queueMs };
        const resourceMaxAgeMs = Math.min(60000, config.vectorTTL || Infinity, config.resourceTTL || Infinity, config.emptyTTL || Infinity);
        worker.child.send({ ...job, timeoutMs: config.upstreamTimeoutMs, resourceMaxAgeMs }, err => { if (err) finish(worker, err); });
      });
    }, { priority: job.priority, key: job.outPath, rank: job.rank }).finally(() => inflight.delete(job.outPath));
    inflight.set(job.outPath, p); return p;
  }
  return {
    render,
    get stats() { return { ...queue.stats, workers: workers.size, spawned, completed, lastRender }; },
    close() {
      queue.close();
      for (const worker of workers) { finish(worker, httpError('Server shutting down', 503)); discard(worker); }
    },
  };
}
module.exports = { createRenderer };
