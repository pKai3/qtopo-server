const { randomUUID } = require('node:crypto');

// A small, public, sampled stream without client identifiers. No tiles are fetched or rendered for it.
function createRenderFlyby({ now = Date.now } = {}) {
  const session = randomUUID(), limit = 32, leaseMs = 3000, ttlMs = 15000;
  let until = 0, nextSample = 0, sequence = 0, entries = [];
  function prune() { entries = entries.filter(entry => now() - entry.time < ttlMs); }
  return {
    reserve() {
      const time = now();
      if (time >= until || time < nextSample) return false;
      nextSample = time + 250;
      return true;
    },
    publish(image, job) {
      if (now() >= until || typeof image !== 'string' || image.length > 44000 || !/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(image)) return;
      prune();
      entries.push({ id: ++sequence, time: now(), image: 'data:image/jpeg;base64,' + image,
        zoom: job.z, profile: job.profile || 'classic', priority: ['requested', 'nearby', 'zoom'][job.priority ?? 0] });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    read(after, previousSession) {
      until = now() + leaseMs;
      prune();
      const reset = previousSession !== session || after > sequence;
      return { session, next: sequence, reset, entries: reset ? [] : entries.filter(entry => entry.id > after).slice(-8) };
    },
  };
}
module.exports = { createRenderFlyby };
