// A render owns its resource requests for exactly its lifetime. Consumers of a
// shared download keep independent ownership and promotion subscriptions.
const { randomUUID } = require('node:crypto');
function createWorkOwner(priority = 0) {
  const controller = new AbortController(), listeners = new Set();
  return {
    id: randomUUID(), signal: controller.signal,
    get priority() { return priority; },
    promote(next) {
      if (next >= priority) return;
      priority = next;
      for (const listener of listeners) listener(priority);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    cancel(reason) { controller.abort(reason); listeners.clear(); },
  };
}
module.exports = { createWorkOwner };
