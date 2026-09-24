const path = require('node:path');
const fs = require('node:fs/promises');
const { fork } = require('node:child_process');
const { WorkQueue } = require('./queue');
const { httpError, cachedRaster } = require('./utils');
function createRenderer(config, workerPath = path.join(__dirname, 'render_worker.js')) {
  const queue = new WorkQueue(config.renderConcurrency, config.renderQueueLimit);
  const inflight = new Map();
  const children = new Set();
  function render(job) {
    if (inflight.has(job.outPath)) return inflight.get(job.outPath);
    const p = queue.run(async () => {
      const cached = await cachedRaster(job.outPath, config.rasterTTL, config.emptyTTL);
      if (cached?.size) return job.outPath;
      await fs.mkdir(path.dirname(job.outPath), { recursive: true });
      if (queue.closed) throw httpError('Server shutting down', 503);
      return new Promise((resolve, reject) => {
        let workerError;
        const child = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        children.add(child);
        const timer = setTimeout(() => { workerError = httpError('Render timed out', 504); child.kill('SIGKILL'); }, config.renderTimeoutMs);
        child.on('message', msg => { if (msg.error) workerError = httpError(msg.error); });
        child.on('error', err => { workerError = err; });
        child.on('close', async code => {
          clearTimeout(timer); children.delete(child);
          if (code !== 0 || workerError) return reject(workerError || httpError(`Renderer exited ${code}`));
          try {
            if (!(await cachedRaster(job.outPath, config.rasterTTL, config.emptyTTL))?.size) throw httpError('Renderer produced no output');
            resolve(job.outPath);
          } catch (err) { reject(err); }
        });
        child.send({ ...job, timeoutMs: config.upstreamTimeoutMs });
      });
    }).finally(() => inflight.delete(job.outPath));
    inflight.set(job.outPath, p); return p;
  }
  return {
    render, get stats() { return queue.stats; },
    close() { queue.close(); for (const child of children) child.kill('SIGTERM'); },
  };
}
module.exports = { createRenderer };
