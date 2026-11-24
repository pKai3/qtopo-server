const { httpError } = require('./utils');
const PRIORITY = { REQUEST: 0, NEIGHBOUR: 1, ZOOM: 2 };
class WorkQueue {
  constructor(concurrency, limit, backgroundConcurrency = Math.max(1, concurrency - 1), canStart = () => true) {
    this.concurrency = concurrency; this.limit = limit;
    this.backgroundConcurrency = Math.min(backgroundConcurrency, Math.max(1, concurrency - 1));
    this.active = 0; this.peakActive = 0; this.running = [0, 0, 0]; this.waiting = []; this.closed = false;
    this.activeEntries = new Set();
    this.canStart = canStart;
  }
  run(work, { priority = PRIORITY.REQUEST, key, rank = 0, score = () => 0, job, clients = () => [], signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
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
    let abort;
    const pending = new Promise((resolve, reject) => {
      const queuedAt = Date.now();
      const entry = { work, resolve, reject, priority, key, rank, score, job, clients, queuedAt,
        requestedAt: priority === PRIORITY.REQUEST ? queuedAt : undefined };
      abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index !== -1) { this.waiting.splice(index, 1); reject(signal.reason); this.drain(); }
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(entry); this.drain();
    });
    return pending.finally(() => signal?.removeEventListener('abort', abort));
  }
  promote(key, priority = PRIORITY.REQUEST, rank = 0) {
    if (key === undefined) return;
    const entry = this.waiting.find(entry => entry.key === key) || [...this.activeEntries].find(entry => entry.key === key);
    if (!entry) return;
    const promoted = Math.min(entry.priority, priority);
    if (promoted === PRIORITY.REQUEST) entry.requestedAt ??= Date.now();
    if (this.activeEntries.has(entry) && promoted !== entry.priority) {
      this.running[entry.priority]--; this.running[promoted]++;
    }
    entry.priority = promoted; entry.rank = Math.max(entry.rank, rank); this.drain();
  }
  next() {
    const priority = Math.min(...this.waiting.map(entry => entry.priority));
    return this.waiting.filter(entry => entry.priority === priority)
      .map(entry => ({ entry, score: entry.score() }))
      .sort((a, b) => b.score - a.score || (priority === PRIORITY.REQUEST ? 0 : b.entry.rank - a.entry.rank))[0]?.entry;
  }
  drain() {
    while (!this.closed && this.active < this.concurrency && this.waiting.length) {
      const next = this.next(), priority = next.priority;
      if (priority > PRIORITY.REQUEST) {
        if (this.running[1] + this.running[2] >= this.backgroundConcurrency || this.active >= Math.max(1, this.concurrency - 1)) break;
      }
      if (!this.canStart(next)) break;
      const index = this.waiting.indexOf(next);
      const entry = this.waiting.splice(index, 1)[0];
      const { work, resolve, reject } = entry;
      this.activeEntries.add(entry);
      this.active++; this.running[priority]++; this.peakActive = Math.max(this.peakActive, this.active);
      Promise.resolve().then(work).then(resolve, reject).finally(() => {
        this.activeEntries.delete(entry);
        this.active--; this.running[entry.priority]--; this.drain();
      });
    }
  }
  close() { this.closed = true; for (const job of this.waiting.splice(0)) job.reject(httpError('Server shutting down', 503)); }
  get stats() {
    const requested = this.waiting.filter(job => job.priority === PRIORITY.REQUEST);
    return {
      active: this.active, queued: this.waiting.length, concurrency: this.concurrency,
      backgroundConcurrency: this.backgroundConcurrency, peakActive: this.peakActive,
      activeByPriority: { requested: this.running[0], neighbours: this.running[1], zoom: this.running[2] },
      queuedByPriority: {
        requested: requested.length,
        neighbours: this.waiting.filter(job => job.priority === PRIORITY.NEIGHBOUR).length,
        zoom: this.waiting.filter(job => job.priority === PRIORITY.ZOOM).length,
      },
      oldestQueuedMs: this.waiting.length ? Math.max(...this.waiting.map(job => Date.now() - job.queuedAt)) : 0,
      oldestRequestedQueuedMs: requested.length ? Math.max(...requested.map(job => Date.now() - job.requestedAt)) : 0,
    };
  }
}
module.exports = { WorkQueue, PRIORITY };
