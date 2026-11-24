const { gunzipSync } = require('node:zlib');
const { atomicWrite, cachedFile, httpError, imageType } = require('./utils');
const { WorkQueue, PRIORITY } = require('./queue');
function createCache({ timeoutMs = 20000, emptyTTL = 1800000, concurrency = 16, fetchImpl = fetch, logger } = {}) {
  const inflight = new Map();
  const downloads = new WorkQueue(concurrency, 1024, Math.max(1, Math.floor(concurrency / 2)));
  const stats = { hits: 0, misses: 0, errors: 0, activeDownloads: 0, peakDownloads: 0 };
  async function get({ file, url, ttl = 0, kind = 'pbf', allowEmpty = true, logTag, priority = PRIORITY.REQUEST }) {
    const log = (tag, message) => { if (logTag) logger?.log(tag, message); };
    const key = `${file}\n${url}`;
    if (inflight.has(key)) {
      const entry = inflight.get(key); entry.priority = Math.min(entry.priority, priority);
      downloads.promote(key, priority); return entry.promise;
    }
    const entry = { priority };
    const pending = (async () => {
      const stat = await cachedFile(file, ttl);
      if (stat && (stat.size || Date.now() - stat.mtimeMs < emptyTTL)) {
        log(logTag, `Cached: ${file} (${stat.size} bytes${stat.size ? '' : ', empty'})`);
        stats.hits++; return { path: file, empty: stat.size === 0 };
      }
      stats.misses++;
      return downloads.run(async () => {
        stats.activeDownloads++; stats.peakDownloads = Math.max(stats.peakDownloads, stats.activeDownloads);
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          if (logTag) {
            const upstream = new URL(url);
            log(`${logTag}-GET`, `${upstream.origin}${upstream.pathname}`);
          }
          const res = await fetchImpl(url, { signal: controller.signal });
          if (allowEmpty && (res.status === 204 || res.status === 404)) {
            await res.body?.cancel(); await atomicWrite(file, Buffer.alloc(0));
            log(logTag, `Empty: ${file} (upstream HTTP ${res.status}, ${Date.now() - started} ms)`);
            return { path: file, empty: true };
          }
          if (!res.ok) { await res.body?.cancel(); throw httpError(`Upstream HTTP ${res.status}`); }
          const chunks = []; let size = 0;
          for await (const chunk of res.body || []) {
            size += chunk.length;
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
          await atomicWrite(file, data);
          log(logTag, `Saved: ${file} (${data.length} bytes, ${Date.now() - started} ms)`);
          return { path: file, empty: !data.length };
        } catch (err) {
          stats.errors++;
          if (err.name === 'AbortError') throw httpError('Upstream request timed out', 504);
          throw err;
        } finally { clearTimeout(timer); stats.activeDownloads--; }
      }, { key, priority: entry.priority });
    })().finally(() => inflight.delete(key));
    entry.promise = pending; inflight.set(key, entry); return pending;
  }
  return { get, get stats() { return { ...stats, downloads: downloads.stats }; }, close() { downloads.close(); } };
}
module.exports = { createCache };
