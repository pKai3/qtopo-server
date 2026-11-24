const { gunzipSync } = require('node:zlib');
const { atomicWrite, cachedFile, httpError, imageType } = require('./utils');
const { WorkQueue, PRIORITY } = require('./queue');
function createCache({ timeoutMs = 20000, emptyTTL = 1800000, concurrency = 16, fetchImpl = fetch, logger } = {}) {
  const inflight = new Map();
  // Speculation may borrow every free download slot. A queued request can
  // interrupt a background attempt, which retries behind requested resources.
  const downloads = new WorkQueue(concurrency, 1024, concurrency, () => true, { reserveForeground: false });
  const stats = { hits: 0, misses: 0, errors: 0, cancelled: 0, yielded: 0, activeDownloads: 0, peakDownloads: 0 };
  const unused = () => httpError('Download no longer needed', 503);
  const yielded = () => Object.assign(httpError('Download yielded to requested resource', 503), { retryDownload: true });
  let closed = false;
  function yieldForRequests() {
    const requested = downloads.waiting.filter(entry => entry.priority === PRIORITY.REQUEST).length;
    const releasing = [...downloads.activeEntries].filter(job => inflight.get(job.key)?.attempt?.signal.aborted).length;
    const needed = requested - releasing;
    if (needed <= 0) return;
    const victims = [...downloads.activeEntries].filter(job => job.priority > PRIORITY.REQUEST)
      .sort((a, b) => b.priority - a.priority).map(job => inflight.get(job.key))
      .filter(entry => entry?.attempt && !entry.attempt.signal.aborted &&
        [...entry.consumers].every(consumer => (consumer.owner?.priority ?? consumer.priority) > PRIORITY.REQUEST));
    for (const entry of victims.slice(0, needed)) { stats.yielded++; entry.attempt.abort(yielded()); }
  }
  function promote(entry) {
    const priority = Math.min(...[...entry.consumers].map(consumer => consumer.owner?.priority ?? consumer.priority));
    entry.priority = Math.min(entry.priority, priority);
    downloads.promote(entry.key, entry.priority);
    yieldForRequests();
  }
  async function download(entry, options) {
    const { file, url, kind, allowEmpty, logTag } = options;
    const log = (tag, message) => { if (logTag) logger?.log(tag, message); };
    const stat = await cachedFile(file, options.ttl);
    entry.controller.signal.throwIfAborted();
    if (stat && (stat.size || Date.now() - stat.mtimeMs < emptyTTL)) {
      stats.hits++; log(logTag, `Cached: ${file} (${stat.size} bytes${stat.size ? '' : ', empty'})`);
      return { path: file, empty: stat.size === 0 };
    }
    stats.misses++;
    while (true) {
      entry.controller.signal.throwIfAborted();
      const pending = downloads.run(async () => {
        entry.controller.signal.throwIfAborted();
        stats.activeDownloads++; stats.peakDownloads = Math.max(stats.peakDownloads, stats.activeDownloads);
        const started = Date.now(), attempt = new AbortController();
        entry.attempt = attempt;
        const signal = AbortSignal.any([entry.controller.signal, attempt.signal]);
        const timer = setTimeout(() => attempt.abort(httpError('Upstream request timed out', 504)), timeoutMs);
        try {
          yieldForRequests(); signal.throwIfAborted();
          if (logTag) { const upstream = new URL(url); log(`${logTag}-GET`, `${upstream.origin}${upstream.pathname}`); }
          const res = await fetchImpl(url, { signal });
          signal.throwIfAborted();
          if (allowEmpty && (res.status === 204 || res.status === 404)) {
            await res.body?.cancel(); signal.throwIfAborted(); await atomicWrite(file, Buffer.alloc(0));
            return { path: file, empty: true };
          }
          if (!res.ok) { await res.body?.cancel(); throw httpError(`Upstream HTTP ${res.status}`); }
          const chunks = []; let size = 0;
          for await (const chunk of res.body || []) {
            signal.throwIfAborted(); size += chunk.length;
            if (size > 32 * 1024 * 1024) throw httpError('Upstream resource exceeds 32 MiB');
            chunks.push(chunk);
          }
          let data = Buffer.concat(chunks);
          if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data, { maxOutputLength: 32 * 1024 * 1024 });
          if (!data.length && !allowEmpty) throw httpError('Empty upstream resource');
          if (data.length) {
            if (kind === 'image' && !imageType(data)) throw httpError('Upstream did not return PNG or JPEG');
            if (kind === 'pbf' && (/json|html|text\//i.test(res.headers.get('content-type') || '') || data[0] === 60 || data[0] === 123)) throw httpError('Upstream returned an error document instead of a vector tile');
            if (kind === 'json') JSON.parse(data.toString());
          }
          signal.throwIfAborted(); await atomicWrite(file, data);
          log(logTag, `Saved: ${file} (${data.length} bytes, ${Date.now() - started} ms)`);
          return { path: file, empty: !data.length };
        } catch (err) {
          if (signal.aborted) throw signal.reason;
          throw err;
        } finally {
          clearTimeout(timer); stats.activeDownloads--;
          if (entry.attempt === attempt) entry.attempt = null;
        }
      }, { key: entry.key, priority: entry.priority, signal: entry.controller.signal });
      yieldForRequests();
      try { return await pending; }
      catch (err) {
        if (err.retryDownload && !entry.controller.signal.aborted) continue;
        if (!entry.controller.signal.aborted) stats.errors++;
        throw err;
      }
    }
  }
  function get({ file, url, ttl = 0, kind = 'pbf', allowEmpty = true, logTag, priority = PRIORITY.REQUEST, signal, owner }) {
    if (closed) return Promise.reject(httpError('Server shutting down', 503));
    if (owner) signal = signal ? AbortSignal.any([signal, owner.signal]) : owner.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = `${file}\n${url}`;
    let entry = inflight.get(key), fresh = false;
    if (!entry || entry.controller.signal.aborted) {
      fresh = true;
      entry = { key, priority: owner?.priority ?? priority, consumers: new Set(), controller: new AbortController(), settled: false };
      inflight.set(key, entry);
    }
    const consumer = { priority, owner };
    entry.consumers.add(consumer);
    if (fresh) {
      entry.promise = download(entry, { file, url, ttl, kind, allowEmpty, logTag }).finally(() => {
        entry.settled = true;
        if (inflight.get(key) === entry) inflight.delete(key);
      });
    }
    promote(entry);
    return new Promise((resolve, reject) => {
      let done = false;
      const unsubscribe = owner?.subscribe(() => promote(entry));
      const finish = (error, value) => {
        if (done) return; done = true;
        signal?.removeEventListener('abort', onAbort); unsubscribe?.(); entry.consumers.delete(consumer);
        if (!entry.settled && !entry.consumers.size) {
          stats.cancelled++; entry.controller.abort(unused());
          if (inflight.get(key) === entry) inflight.delete(key);
        }
        if (error) reject(error); else resolve(value);
      };
      const onAbort = () => finish(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(value => finish(null, value), finish);
      if (signal?.aborted) onAbort();
    });
  }
  return { get, get stats() { return { ...stats, downloads: downloads.stats }; }, close() {
    closed = true;
    for (const entry of inflight.values()) entry.controller.abort(httpError('Server shutting down', 503));
    downloads.close();
  } };
}
module.exports = { createCache };
