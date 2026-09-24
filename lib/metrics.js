// Keep a bounded recent sample; monitoring must not grow with the tile cache.
function createTimings(fields, limit = 256) {
  const samples = [];
  let count = 0, cursor = 0;
  return {
    record(sample) { count++; samples[cursor] = sample; cursor = (cursor + 1) % limit; },
    get stats() {
      const result = { count, samples: samples.length };
      for (const field of fields) {
        const values = samples.map(s => s[field]).filter(Number.isFinite).sort((a, b) => a - b);
        const percentile = fraction => values.length ? Math.round(values[Math.ceil(values.length * fraction) - 1]) : null;
        result[field] = { p50: percentile(0.5), p95: percentile(0.95) };
      }
      return result;
    },
  };
}
function createRequestMetrics() {
  const timings = createTimings(['readyMs', 'responseMs']);
  const cachedTimings = createTimings(['readyMs', 'responseMs']);
  const prefetched = new Map();
  let active = 0, completed = 0, errors = 0, disconnected = 0, hits = 0, misses = 0, bytes = 0, prefetchUsed = 0;
  return {
    prefetched(result) {
      if (result.hit) return;
      prefetched.delete(result.path); prefetched.set(result.path, true);
      if (prefetched.size > 1024) prefetched.delete(prefetched.keys().next().value);
    },
    begin() {
      active++;
      const started = performance.now();
      let readyMs, hit, file, finished = false;
      return {
        ready(result) {
          readyMs = performance.now() - started; hit = result.hit; file = result.path;
        },
        finish(status, closed, size = 0) {
          if (finished) return; finished = true; active--;
          if (closed) { disconnected++; return; }
          if (status >= 400) { errors++; return; }
          completed++; bytes += Number(size) || 0;
          if (hit && prefetched.delete(file)) prefetchUsed++;
          if (hit) hits++; else misses++;
          const sample = { readyMs, responseMs: performance.now() - started };
          timings.record(sample); if (hit) cachedTimings.record(sample);
        },
      };
    },
    get stats() {
      return {
        active, completed, errors, disconnected, hits, misses, bytes, prefetchUsed,
        hitPercent: hits + misses ? Math.round(100 * hits / (hits + misses)) : null,
        timings: timings.stats, cachedTimings: cachedTimings.stats,
      };
    },
  };
}
module.exports = { createTimings, createRequestMetrics };
