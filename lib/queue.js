const { httpError } = require('./utils');
const PRIORITY = { REQUEST: 0, NEIGHBOUR: 1, ZOOM: 2 };
class WorkQueue {
  constructor(concurrency, limit, backgroundConcurrency = Math.max(1, concurrency - 1)) {
    this.concurrency = concurrency; this.limit = limit;
    this.backgroundConcurrency = Math.min(backgroundConcurrency, Math.max(1, concurrency - 1));
    this.active = 0; this.peakActive = 0; this.running = [0, 0, 0]; this.waiting = []; this.closed = false;
  }
  run(work, { priority = PRIORITY.REQUEST, key, rank = 0 } = {}) {
    if (this.closed) return Promise.reject(httpError('Renderer busy; retry shortly', 503));
    if (this.waiting.length >= this.limit) {
      // Discard lower tiers or older speculative work; protect requested tiles.
      const worst = Math.max(...this.waiting.map(entry => entry.priority));
      const victim = this.waiting.filter(entry => entry.priority === worst).sort((a, b) => a.rank - b.rank)[0];
      if (worst > priority || (priority > PRIORITY.REQUEST && worst === priority && rank > victim.rank)) {
        this.waiting.splice(this.waiting.indexOf(victim), 1)[0].reject(httpError('Prefetch superseded', 503));
      }
    }
    if (this.waiting.length >= this.limit) return Promise.reject(httpError('Renderer busy; retry shortly', 503));
    return new Promise((resolve, reject) => { this.waiting.push({ work, resolve, reject, priority, key, rank, queuedAt: Date.now() }); this.drain(); });
  }
  promote(key, priority = PRIORITY.REQUEST, rank = 0) {
    const entry = this.waiting.find(entry => entry.key === key);
    if (entry) { entry.priority = Math.min(entry.priority, priority); entry.rank = Math.max(entry.rank, rank); this.drain(); }
  }
  drain() {
    while (!this.closed && this.active < this.concurrency && this.waiting.length) {
      const priority = Math.min(...this.waiting.map(entry => entry.priority));
      if (priority > PRIORITY.REQUEST) {
        if (this.running[1] + this.running[2] >= this.backgroundConcurrency || this.active >= Math.max(1, this.concurrency - 1)) break;
        if (priority === PRIORITY.ZOOM && (this.running[0] || this.running[1])) break;
      }
      const next = this.waiting.filter(entry => entry.priority === priority).sort((a, b) => priority === PRIORITY.REQUEST ? 0 : b.rank - a.rank)[0];
      const index = this.waiting.indexOf(next);
      const { work, resolve, reject } = this.waiting.splice(index, 1)[0];
      this.active++; this.running[priority]++; this.peakActive = Math.max(this.peakActive, this.active);
      Promise.resolve().then(work).then(resolve, reject).finally(() => {
        this.active--; this.running[priority]--; this.drain();
      });
    }
  }
  close() { this.closed = true; for (const job of this.waiting.splice(0)) job.reject(httpError('Server shutting down', 503)); }
  get stats() {
    return {
      active: this.active, queued: this.waiting.length, concurrency: this.concurrency,
      backgroundConcurrency: this.backgroundConcurrency, peakActive: this.peakActive,
      activeByPriority: { requested: this.running[0], neighbours: this.running[1], zoom: this.running[2] },
      queuedByPriority: {
        requested: this.waiting.filter(job => job.priority === PRIORITY.REQUEST).length,
        neighbours: this.waiting.filter(job => job.priority === PRIORITY.NEIGHBOUR).length,
        zoom: this.waiting.filter(job => job.priority === PRIORITY.ZOOM).length,
      },
      oldestQueuedMs: this.waiting.length ? Math.max(...this.waiting.map(job => Date.now() - job.queuedAt)) : 0,
    };
  }
}
module.exports = { WorkQueue, PRIORITY };
