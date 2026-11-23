const { PRIORITY } = require('./queue');
function neighbours(tile, radius) {
  const tiles = [], n = 2 ** tile.z;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const x = tile.x + dx, y = tile.y + dy;
    if ((dx || dy) && x >= 0 && y >= 0 && x < n && y < n) tiles.push({ z: tile.z, x, y });
  }
  return tiles.sort((a, b) => ((a.x - tile.x) ** 2 + (a.y - tile.y) ** 2) - ((b.x - tile.x) ** 2 + (b.y - tile.y) ** 2));
}
function zoomNeighbours(tile, { minzoom = 0, maxzoom = 19 } = {}) {
  const tiles = [];
  if (tile.z > minzoom) tiles.push({ z: tile.z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) });
  if (tile.z < maxzoom) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    tiles.push({ z: tile.z + 1, x: tile.x * 2 + dx, y: tile.y * 2 + dy });
  }
  return tiles;
}
function createPrefetch({ radius = 1, zoom = true, concurrency = 1, limit = 64, delayMs = 500, zoomRange = () => ({}), groupKey, render, logger }) {
  const pending = new Map(), recent = new Map(), active = new Map(), activeGroups = new Map();
  let timer, requests = 0, closed = false, paused = false, completed = 0, completedZoom = 0, quietUntil = 0, sequence = 0;
  const key = (provider, tile) => `${provider}/${tile.z}/${tile.x}/${tile.y}`;
  function remember(id) {
    recent.delete(id); recent.set(id, Date.now());
    if (recent.size > limit * 4) recent.delete(recent.keys().next().value);
  }
  function schedule() {
    if (closed || paused || !radius || timer || !pending.size) return;
    if (activeGroups.size >= concurrency && ![...pending.values()].some(job => activeGroups.has(job.group))) return;
    timer = setTimeout(drain, Math.max(0, quietUntil - Date.now())); timer.unref();
  }
  function drain() {
    timer = null;
    if (closed || paused || Date.now() < quietUntil) return schedule();
    while (pending.size) {
      const entry = [...pending].sort(([, a], [, b]) => a.priority - b.priority || b.rank - a.rank || a.order - b.order)
        .find(([, job]) => activeGroups.size < concurrency || activeGroups.has(job.group));
      if (!entry) break;
      const [id, job] = entry;
      // Prefer queued neighbours, but let zoom work use spare capacity while
      // earlier neighbours or requests are still running. The render queue
      // keeps a foreground slot reserved and applies the same priority order.
      pending.delete(id); active.set(id, job);
      // Multiple tiles can await one metatile render. Charge that group once,
      // but keep every tile's promise so partial success/failure stays accurate.
      activeGroups.set(job.group, (activeGroups.get(job.group) || 0) + 1);
      Promise.resolve().then(() => render(job.provider, job.tile, job.priority, job.rank)).then(() => {
        completed++; if (job.priority === PRIORITY.ZOOM) completedZoom++; remember(id);
      }).catch(err => {
        if (!closed && err.status !== 503) logger?.warn('PREFETCH', `${id}: ${err.message}`);
      }).finally(() => {
        active.delete(id);
        const remaining = activeGroups.get(job.group) - 1;
        if (remaining) activeGroups.set(job.group, remaining); else activeGroups.delete(job.group);
        schedule();
      });
    }
  }
  function enqueue(provider, tile, priority, rank, order) {
    const id = key(provider, tile);
    if (active.has(id) || Date.now() - (recent.get(id) || 0) < 60000) return;
    const previous = pending.get(id);
    if (previous) {
      previous.priority = Math.min(previous.priority, priority);
      if (rank >= previous.rank) { previous.rank = rank; previous.order = order; }
    } else pending.set(id, { provider, tile, priority, rank, order, group: groupKey?.(provider, tile) ?? id });
    if (pending.size > limit) {
      const worst = [...pending].sort(([, a], [, b]) => b.priority - a.priority || a.rank - b.rank || b.order - a.order)[0];
      pending.delete(worst[0]);
    }
  }
  return {
    begin(provider, tile) {
      if (closed || paused || !radius) return () => {};
      requests++;
      const rank = ++sequence;
      const id = key(provider, tile); pending.delete(id);
      let finished = false;
      return (success = false) => {
        if (finished) return; finished = true; requests--;
        if (success && !closed && !paused) {
          // Debounce the start of a burst only. The render queue protects live
          // requests while spare workers can keep preparing same-zoom tiles.
          if (!pending.size && !active.size) quietUntil = Date.now() + delayMs;
          remember(id);
          neighbours(tile, radius).forEach((neighbour, order) => enqueue(provider, neighbour, PRIORITY.NEIGHBOUR, rank, order));
          if (zoom) zoomNeighbours(tile, zoomRange(provider)).forEach((neighbour, order) => enqueue(provider, neighbour, PRIORITY.ZOOM, rank, order));
        }
        schedule();
      };
    },
    get stats() {
      return {
        enabled: !!radius, paused, zoomEnabled: !!radius && zoom, concurrency,
        active: active.size, activeGroups: activeGroups.size, queued: pending.size, completed, completedZoom, requests,
        queuedNeighbours: [...pending.values()].filter(job => job.priority === PRIORITY.NEIGHBOUR).length,
        queuedZoom: [...pending.values()].filter(job => job.priority === PRIORITY.ZOOM).length,
      };
    },
    pause() { paused = true; clearTimeout(timer); timer = null; pending.clear(); },
    resume() { paused = false; recent.clear(); schedule(); },
    close() { closed = true; clearTimeout(timer); pending.clear(); },
  };
}
module.exports = { createPrefetch, neighbours, zoomNeighbours };
