const path = require('node:path');

// Readers/writers share a lease. Eviction takes an exclusive lease, so a new
// request arriving during unlink waits and then sees a normal cache miss.
function createCacheFiles() {
  const entries = new Map();
  const key = file => path.resolve(file.replace(/\.empty$/, ''));
  async function hold(file) {
    const id = key(file);
    while (entries.get(id)?.deleting) await entries.get(id).deleting;
    const entry = entries.get(id) || { users: 0 };
    entries.set(id, entry); entry.users++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!--entry.users && entries.get(id) === entry) entries.delete(id);
    };
  }
  async function evict(file, remove) {
    const id = key(file);
    if (entries.has(id)) return false;
    let done;
    const entry = { deleting: new Promise(resolve => { done = resolve; }) };
    entries.set(id, entry);
    try { await remove(); return true; }
    finally { entries.delete(id); done(); }
  }
  function scope() {
    const leases = new Map();
    let closed = false;
    return {
      async hold(file) {
        const id = key(file);
        if (!leases.has(id)) leases.set(id, hold(file).then(release => {
          if (closed) release();
          return release;
        }));
        await leases.get(id);
      },
      close() { closed = true; for (const lease of leases.values()) lease.then(release => release()); leases.clear(); },
    };
  }
  return { hold, evict, scope, busy: file => entries.has(key(file)) };
}
module.exports = { createCacheFiles };
