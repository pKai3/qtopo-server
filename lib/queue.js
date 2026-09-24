const { httpError } = require('./utils');
class WorkQueue {
  constructor(concurrency, limit) { this.concurrency = concurrency; this.limit = limit; this.active = 0; this.waiting = []; this.closed = false; }
  run(work) {
    if (this.closed || this.waiting.length >= this.limit) return Promise.reject(httpError('Renderer busy; retry shortly', 503));
    return new Promise((resolve, reject) => { this.waiting.push({ work, resolve, reject }); this.drain(); });
  }
  drain() {
    while (!this.closed && this.active < this.concurrency && this.waiting.length) {
      const { work, resolve, reject } = this.waiting.shift(); this.active++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => { this.active--; this.drain(); });
    }
  }
  close() { this.closed = true; for (const job of this.waiting.splice(0)) job.reject(httpError('Server shutting down', 503)); }
  get stats() { return { active: this.active, queued: this.waiting.length, concurrency: this.concurrency }; }
}
module.exports = { WorkQueue };
