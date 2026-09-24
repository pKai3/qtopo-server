const { httpError } = require('./utils');
class WorkQueue {
  constructor(concurrency, limit) { this.concurrency = concurrency; this.limit = limit; this.active = 0; this.backgroundActive = 0; this.waiting = []; this.closed = false; }
  run(work, { background = false, key } = {}) {
    // Speculative work must never consume a foreground queue slot.
    if (!background && this.waiting.length >= this.limit) {
      const index = this.waiting.findIndex(entry => entry.background);
      if (index !== -1) this.waiting.splice(index, 1)[0].reject(httpError('Prefetch superseded', 503));
    }
    if (this.closed || this.waiting.length >= this.limit) return Promise.reject(httpError('Renderer busy; retry shortly', 503));
    return new Promise((resolve, reject) => { this.waiting.push({ work, resolve, reject, background, key }); this.drain(); });
  }
  promote(key) {
    const entry = this.waiting.find(entry => entry.key === key);
    if (entry) { entry.background = false; this.drain(); }
  }
  drain() {
    while (!this.closed && this.active < this.concurrency && this.waiting.length) {
      let index = this.waiting.findIndex(entry => !entry.background);
      if (index === -1) {
        // At most one speculative render; reserve an incoming request's slot
        // when concurrency permits. Already running renders finish normally.
        if (this.backgroundActive || this.active >= Math.max(1, this.concurrency - 1)) break;
        index = 0;
      }
      const { work, resolve, reject, background } = this.waiting.splice(index, 1)[0]; this.active++;
      if (background) this.backgroundActive++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => {
        this.active--; if (background) this.backgroundActive--; this.drain();
      });
    }
  }
  close() { this.closed = true; for (const job of this.waiting.splice(0)) job.reject(httpError('Server shutting down', 503)); }
  get stats() { return { active: this.active, queued: this.waiting.length, concurrency: this.concurrency }; }
}
module.exports = { WorkQueue };
