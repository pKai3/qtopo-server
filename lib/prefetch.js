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
function createPrefetch({ radius = 1, zoom = true, concurrency = 1, limit = 64, delayMs = 500, zoomRange = () => ({}), render, logger }) {
  const pending = new Map(), recent = new Map(), active = new Map();
  let timer, requests = 0, closed = false, completed = 0, completedZoom = 0, quietUntil = 0, sequence = 0;
  const key = (provider, tile) => `${provider}/${tile.z}/${tile.x}/${tile.y}`;
  function remember(id) {
    recent.delete(id); recent.set(id, Date.now());
    if (recent.size > limit * 4) recent.delete(recent.keys().next().value);
  }
  function schedule() {
    if (closed || !radius || timer || active.size >= concurrency || !pending.size) return;
    timer = setTimeout(drain, Math.max(0, quietUntil - Date.now())); timer.unref();
  }
  function drain() {
    timer = null;
    if (closed || Date.now() < quietUntil) return schedule();
    while (active.size < concurrency && pending.size) {
      const entry = [...pending].sort(([, a], [, b]) => a.priority - b.priority || b.rank - a.rank || a.order - b.order)[0];
      const [id, job] = entry;
      // Finish same-zoom neighbours before starting any speculative zoom work.
      if (job.priority === PRIORITY.ZOOM && (requests || [...active.values()].some(task => task.priority === PRIORITY.NEIGHBOUR))) break;
      pending.delete(id); active.set(id, job);
      Promise.resolve().then(() => render(job.provider, job.tile, job.priority, job.rank)).then(() => {
        completed++; if (job.priority === PRIORITY.ZOOM) completedZoom++; remember(id);
      }).catch(err => {
        if (!closed && err.status !== 503) logger?.warn('PREFETCH', `${id}: ${err.message}`);
      }).finally(() => { active.delete(id); schedule(); });
    }
  }
  function enqueue(provider, tile, priority, rank, order) {
    const id = key(provider, tile);
    if (active.has(id) || Date.now() - (recent.get(id) || 0) < 60000) return;
    const previous = pending.get(id);
    if (previous) {
      previous.priority = Math.min(previous.priority, priority);
      if (rank >= previous.rank) { previous.rank = rank; previous.order = order; }
    } else pending.set(id, { provider, tile, priority, rank, order });
    if (pending.size > limit) {
      const worst = [...pending].sort(([, a], [, b]) => b.priority - a.priority || a.rank - b.rank || b.order - a.order)[0];
      pending.delete(worst[0]);
    }
  }
  return {
    begin(provider, tile) {
      if (closed || !radius) return () => {};
      requests++;
      const rank = ++sequence;
      const id = key(provider, tile); pending.delete(id);
      let finished = false;
      return (success = false) => {
        if (finished) return; finished = true; requests--;
        if (success && !closed) {
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
        enabled: !!radius, zoomEnabled: !!radius && zoom, concurrency,
        active: active.size, queued: pending.size, completed, completedZoom, requests,
        queuedNeighbours: [...pending.values()].filter(job => job.priority === PRIORITY.NEIGHBOUR).length,
        queuedZoom: [...pending.values()].filter(job => job.priority === PRIORITY.ZOOM).length,
      };
    },
    close() { closed = true; clearTimeout(timer); pending.clear(); },
  };
}
module.exports = { createPrefetch, neighbours, zoomNeighbours };
