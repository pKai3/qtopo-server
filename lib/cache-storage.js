const fs = require('node:fs/promises');
const path = require('node:path');
const { createCacheFiles } = require('./cache-files');

// A bounded max-heap retains the oldest candidates without indexing the whole
// cache in memory. Expired entries sort before otherwise usable old entries.
function candidates(limit = 4096) {
  const heap = [];
  const compare = (a, b) => Number(b.expired) - Number(a.expired) || a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file);
  return {
    add(item) {
      if (heap.length < limit) {
        let i = heap.push(item) - 1;
        while (i && compare(heap[i], heap[(i - 1) >> 1]) > 0) {
          const parent = (i - 1) >> 1;
          [heap[i], heap[parent]] = [heap[parent], heap[i]]; i = parent;
        }
      } else if (compare(item, heap[0]) < 0) {
        heap[0] = item;
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1;
          if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
          if (compare(heap[i], heap[child]) >= 0) break;
          [heap[i], heap[child]] = [heap[child], heap[i]]; i = child;
        }
      }
    },
    sorted: () => heap.sort(compare),
  };
}

function createCacheStorage(config, logger, { files = createCacheFiles(), statfs = fs.statfs, now = Date.now, autoStart = true } = {}) {
  const configuredRoots = [
    [config.vectorDir, config.vectorTTL], [config.rasterDir, config.rasterTTL], [config.resourceDir, config.resourceTTL],
  ].map(([root, ttl]) => ({ root: path.join(root, 'v2'), ttl }));
  const uniqueRoots = new Map();
  for (const entry of configuredRoots) {
    const previous = uniqueRoots.get(entry.root);
    if (previous) previous.ttl = Math.min(previous.ttl || Infinity, entry.ttl || Infinity);
    else uniqueRoots.set(entry.root, entry);
  }
  const roots = [...uniqueRoots.values()].sort((a, b) => b.root.length - a.root.length);
  const maxBytes = config.cacheMaxBytes ?? 20 * 1024 ** 3;
  const minFreeBytes = config.cacheMinFreeBytes ?? 5 * 1024 ** 3;
  const enabled = !!(maxBytes || minFreeBytes || config.cleanupInterval);
  const state = { enabled, cacheBytes: 0, maxBytes, minFreeBytes, freeBytes: null, files: 0,
    running: false, pressure: false, blocked: false, readFailed: false, removed: 0, reclaimedBytes: 0, lastScanAt: null };
  let running, closed = false, wakeTimer, timer, writes = 0, lastExpiry = -Infinity, lastWarning;
  let devices = new Map();
  async function disks() {
    const result = new Map();
    for (const entry of roots) {
      let info;
      try { info = await fs.lstat(entry.root); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isDirectory()) throw new Error('Cache root must be a directory, not a symlink');
      if (!result.has(info.dev)) {
        const disk = await statfs(entry.root);
        const free = Number(disk.bavail) * Number(disk.bsize);
        if (!Number.isFinite(free) || free < 0) throw new Error('Invalid free disk space reading');
        result.set(info.dev, { root: entry.root, free });
      }
    }
    devices = result;
    state.freeBytes = result.size ? Math.min(...[...result.values()].map(disk => disk.free)) : null;
  }
  const overLimit = () => !!((maxBytes && state.cacheBytes > maxBytes) || (minFreeBytes && [...devices.values()].some(disk => disk.free < minFreeBytes)));
  async function scan(expiry) {
    const oldest = candidates(), byDevice = new Map(), startedWrites = writes;
    const visited = new Set();
    let total = 0, count = 0, expired = 0;
    async function walk(dir, ttl) {
      if (visited.has(dir)) return;
      visited.add(dir);
      let directory;
      try {
        if (!(await fs.lstat(dir)).isDirectory()) return;
        directory = await fs.opendir(dir);
      } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for await (const entry of directory) {
        if (closed) return;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { await walk(file, ttl); continue; }
        if (!entry.isFile() || !/(?:\.(?:png|pbf|image|empty|tmp)$|^tilemap\.json$|^sprite(?:@2x)?\.json$)/.test(entry.name)) continue;
        try {
          const info = await fs.lstat(file);
          if (!info.isFile()) continue;
          let size = info.size, empty = !size;
          if (entry.name.endsWith('.empty')) {
            if ((await fs.lstat(file.slice(0, -6)).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.isFile()) continue;
          }
          if (entry.name.endsWith('.png')) {
            const marker = await fs.lstat(file + '.empty').catch(error => { if (error.code !== 'ENOENT') throw error; });
            if (marker?.isFile()) { empty = true; size += marker.size; }
          }
          total += size; count++;
          const temporary = /\.(tmp|empty)$/.test(entry.name);
          const age = now() - info.mtimeMs;
          if (temporary && age <= 3600000) continue;
          const lifetime = temporary ? 3600000 : empty ? config.emptyTTL : ttl;
          const item = { file, size, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs,
            expired: !!(expiry && lifetime && age > lifetime) };
          if (files.busy(file)) continue;
          if (item.expired) expired++;
          oldest.add(item);
          if (!byDevice.has(item.dev)) byDevice.set(item.dev, candidates());
          byDevice.get(item.dev).add(item);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    for (const { root, ttl } of roots) await walk(root, ttl);
    // Writes concurrent with scanning can be counted twice; this conservative
    // estimate is corrected by the next scan, never used to evict a new file.
    state.cacheBytes = total + writes - startedWrites; state.files = count;
    // A full disk must be able to reclaim its own files even if all globally
    // oldest files happen to live on a different, spacious filesystem.
    const items = [...new Map([...oldest.sorted(), ...[...byDevice.values()].flatMap(heap => heap.sorted())]
      .map(item => [item.file, item])).values()].sort((a, b) => Number(b.expired) - Number(a.expired) || a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
    return { items, expired };
  }
  async function maintain() {
    state.running = true;
    const beforeRemoved = state.removed, beforeBytes = state.reclaimedBytes;
    const expiry = !!config.cleanupInterval && now() - lastExpiry >= config.cleanupInterval;
    let targetBytes, targetFree;
    try {
      await disks();
      while (!closed) {
        const found = await scan(expiry);
        if (targetBytes === undefined) {
          targetBytes = maxBytes && state.cacheBytes > maxBytes ? maxBytes * 0.9 : maxBytes;
          targetFree = new Map([...devices].map(([dev, disk]) => [dev,
            minFreeBytes && disk.free < minFreeBytes ? minFreeBytes * 1.1 : minFreeBytes]));
        }
        let removed = 0;
        for (const item of found.items) {
          if (closed) break;
          const needsSpace = (maxBytes && state.cacheBytes > targetBytes) ||
            (minFreeBytes && devices.get(item.dev)?.free < targetFree.get(item.dev));
          if (!item.expired && !needsSpace) continue;
          await files.evict(item.file, async () => {
            const current = await fs.lstat(item.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
            // A tile refreshed since the scan is no longer an old candidate.
            if (!current?.isFile() || current.ino !== item.ino || current.mtimeMs !== item.mtimeMs) return;
            await fs.unlink(item.file);
            if (item.file.endsWith('.png')) await fs.rm(item.file + '.empty', { force: true });
            state.cacheBytes = Math.max(0, state.cacheBytes - item.size); state.files--;
            state.removed++; state.reclaimedBytes += item.size; removed++;
            if (item.expired) found.expired--;
            const disk = devices.get(item.dev);
            if (disk) disk.free += item.size;
          });
        }
        await disks(); // Open files or other processes may consume freed space.
        const needsMore = (maxBytes && state.cacheBytes > targetBytes) ||
          (minFreeBytes && [...devices].some(([dev, disk]) => disk.free < targetFree.get(dev)));
        if ((!needsMore && !found.expired) || !removed) break;
      }
      state.lastScanAt = new Date(now()).toISOString();
      state.readFailed = false; state.pressure = overLimit(); state.blocked = state.pressure;
      if (expiry) lastExpiry = now();
      if (state.removed > beforeRemoved) logger?.log('STORAGE', `Removed ${state.removed - beforeRemoved} cached files, reclaimed ${state.reclaimedBytes - beforeBytes} bytes.`);
      if (state.blocked && lastWarning !== 'pressure') logger?.warn('STORAGE', 'Cache storage limits remain exceeded; active files and non-cache data are protected.');
      lastWarning = state.blocked ? 'pressure' : null;
    } catch (error) {
      state.readFailed = true; state.blocked = true;
      if (lastWarning !== error.message) logger?.err('STORAGE', error.message);
      lastWarning = error.message;
    } finally { state.running = false; }
    return { ...state };
  }
  function check() {
    if (closed || !enabled) return Promise.resolve({ ...state });
    if (!running) running = maintain().finally(() => { running = null; });
    return running;
  }
  function wake() {
    if (closed || wakeTimer || running) return;
    wakeTimer = setTimeout(() => { wakeTimer = null; check(); }, 1000); wakeTimer.unref();
  }
  async function probe() {
    if (closed || running) return;
    try {
      await disks(); state.pressure = overLimit();
      if (state.pressure || state.blocked || state.readFailed || (config.cleanupInterval && now() - lastExpiry >= config.cleanupInterval)) await check();
    } catch (error) { state.readFailed = true; state.blocked = true; logger?.err('STORAGE', error.message); }
  }
  if (enabled && autoStart) {
    check();
    timer = setInterval(probe, config.cacheCheckIntervalMs ?? 30000); timer.unref();
  }
  return {
    files, check, probe,
    written(size) {
      if (!enabled || closed) return;
      writes += size; state.cacheBytes += size;
      if (maxBytes && state.cacheBytes > maxBytes) wake();
    },
    get stats() { return { ...state }; },
    async close() { closed = true; clearInterval(timer); clearTimeout(wakeTimer); await running; },
  };
}
module.exports = { createCacheStorage };
