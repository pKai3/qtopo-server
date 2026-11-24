const { PRIORITY } = require('./queue');
const { interestScore, rememberInterest } = require('./request-focus');
const { interestClients } = require('./client-queues');
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
// This is a candidate producer, not a second scheduler. All misses go straight
// to the renderer's single bounded priority queue; cache hits need no worker.
function createPrefetch({ radius = 1, zoom = true, limit = 64, zoomRange = () => ({}), render, logger }) {
  const recent = new Map(), tracked = new Map();
  let requests = 0, closed = false, paused = false, completed = 0, completedZoom = 0, cancelled = 0, sequence = 0;
  const key = (provider, tile) => `${provider}/${tile.z}/${tile.x}/${tile.y}`;
  const wanted = job => !job.hasFocus || [...job.interests.values()].some(interest => interest.wanted());
  function remember(id) {
    recent.delete(id); recent.set(id, Date.now());
    if (recent.size > limit * 4) recent.delete(recent.keys().next().value);
  }
  function cancel(job) {
    if (job.controller.signal.aborted) return;
    cancelled++;
    job.controller.abort(Object.assign(new Error('Obsolete prefetch cancelled'), { status: 503 }));
    if (tracked.get(job.id) === job) tracked.delete(job.id);
  }
  function sweep() { for (const job of tracked.values()) if (!wanted(job)) cancel(job); }
  function enqueue(provider, tile, priority, rank, focus) {
    const id = key(provider, tile);
    let job = tracked.get(id);
    if (job?.controller.signal.aborted) job = undefined;
    if (!job && Date.now() - (recent.get(id) || 0) < 60000) return;
    const interest = focus?.forTile(tile);
    if (interest) interest.wanted = focus.current || (() => true);
    if (job) {
      if (interest) { job.hasFocus = true; rememberInterest(job.interests, interest); }
      job.priority = Math.min(job.priority, priority); job.rank = Math.max(job.rank, rank);
      for (const listener of job.listeners) listener();
      return;
    }
    job = { id, priority, rank, interests: new Map(), listeners: new Set(), controller: new AbortController() };
    if (interest) { job.hasFocus = true; rememberInterest(job.interests, interest); }
    tracked.set(id, job);
    const combined = { key: `prefetch/${id}`, score: () => interestScore(job.interests),
      clients: () => interestClients(job.interests), priority: () => job.priority, rank: () => job.rank,
      subscribe: listener => { job.listeners.add(listener); return () => job.listeners.delete(listener); }, wanted: () => wanted(job), signal: job.controller.signal };
    Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted();
      return render(provider, tile, priority, rank, combined);
    }).then(() => {
      completed++; if (priority === PRIORITY.ZOOM) completedZoom++; remember(id);
    }).catch(err => {
      if (!closed && err.status !== 503) logger?.warn('PREFETCH', `${id}: ${err.message}`);
    }).finally(() => { if (tracked.get(id) === job) tracked.delete(id); job.listeners.clear(); });
  }
  return {
    begin(provider, tile, focus) {
      if (closed || paused || !radius) return () => {};
      requests++;
      const rank = ++sequence;
      let finished = false;
      return (success = false) => {
        if (finished) return; finished = true; requests--;
        sweep();
        if (!success || closed || paused || (focus?.current && !focus.current())) return;
        remember(key(provider, tile));
        // Keep a single burst bounded even at radius ten. Queue admission,
        // priority, metatile deduplication and eviction all belong to renderer.
        const candidates = neighbours(tile, radius).map(tile => ({ tile, priority: PRIORITY.NEIGHBOUR }));
        if (zoom) candidates.push(...zoomNeighbours(tile, zoomRange(provider)).map(tile => ({ tile, priority: PRIORITY.ZOOM })));
        for (const candidate of candidates.slice(0, limit)) enqueue(provider, candidate.tile, candidate.priority, rank, focus);
      };
    },
    sweep,
    get stats() { return { enabled: !!radius, paused, zoomEnabled: !!radius && zoom,
      tracked: tracked.size, completed, completedZoom, cancelled, requests }; },
    pause() { paused = true; for (const job of tracked.values()) cancel(job); },
    resume() { paused = false; recent.clear(); },
    close() { closed = true; for (const job of tracked.values()) cancel(job); },
  };
}
module.exports = { createPrefetch, neighbours, zoomNeighbours };
