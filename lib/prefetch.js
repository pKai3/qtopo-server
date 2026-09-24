function neighbours(tile, radius) {
  const tiles = [], n = 2 ** tile.z;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const x = tile.x + dx, y = tile.y + dy;
    if ((dx || dy) && x >= 0 && y >= 0 && x < n && y < n) tiles.push({ z: tile.z, x, y });
  }
  return tiles.sort((a, b) => (Math.abs(a.x - tile.x) + Math.abs(a.y - tile.y)) - (Math.abs(b.x - tile.x) + Math.abs(b.y - tile.y)));
}
function createPrefetch({ radius = 1, limit = 64, delayMs = 500, render, logger }) {
  const pending = new Map(), recent = new Map();
  let timer, active = false, requests = 0, closed = false, completed = 0;
  const key = (provider, tile) => `${provider}/${tile.z}/${tile.x}/${tile.y}`;
  function schedule() {
    if (closed || !radius || timer || active || requests || !pending.size) return;
    timer = setTimeout(drain, delayMs); timer.unref();
  }
  async function drain() {
    timer = null;
    if (closed || active || requests || !pending.size) return;
    const [id, job] = pending.entries().next().value;
    pending.delete(id); active = true;
    try {
      await render(job.provider, job.tile);
      completed++; recent.delete(id); recent.set(id, Date.now());
      if (recent.size > limit * 4) recent.delete(recent.keys().next().value);
    } catch (err) {
      if (!closed && err.status !== 503) logger?.warn('PREFETCH', `${id}: ${err.message}`);
    } finally { active = false; schedule(); }
  }
  return {
    begin(provider, tile) {
      if (closed || !radius) return () => {};
      requests++; clearTimeout(timer); timer = null;
      const id = key(provider, tile); pending.delete(id);
      let finished = false;
      return (success = false) => {
        if (finished) return; finished = true; requests--;
        if (success && !closed) {
          recent.delete(id); recent.set(id, Date.now());
          if (recent.size > limit * 4) recent.delete(recent.keys().next().value);
          for (const neighbour of neighbours(tile, radius)) {
            const next = key(provider, neighbour);
            if (Date.now() - (recent.get(next) || 0) < 60000) continue;
            if (!pending.has(next)) pending.set(next, { provider, tile: neighbour });
            if (pending.size > limit) pending.delete(pending.keys().next().value);
          }
        }
        schedule();
      };
    },
    get stats() { return { enabled: !!radius, active: Number(active), queued: pending.size, completed }; },
    close() { closed = true; clearTimeout(timer); pending.clear(); },
  };
}
module.exports = { createPrefetch, neighbours };
