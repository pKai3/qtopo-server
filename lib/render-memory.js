const fs = require('node:fs');
const MIB = 1024 ** 2;

function readCgroupMemory(read = file => fs.readFileSync(file, 'utf8')) {
  for (const [limitFile, usageFile, statFile, inactiveKey] of [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.stat', 'inactive_file'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file'],
  ]) {
    let raw;
    try { raw = read(limitFile).trim(); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const limit = Number(raw);
    if (raw === 'max' || limit >= 2 ** 60) return null;
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('Invalid cgroup memory limit');
    const current = Number(read(usageFile));
    const stat = Object.fromEntries(read(statFile).trim().split('\n').map(line => {
      const [key, value] = line.split(/\s+/); return [key, Number(value)];
    }));
    if (!Number.isFinite(current) || current < 0 || !Number.isFinite(stat[inactiveKey])) throw new Error('Invalid cgroup memory usage');
    // Inactive file cache can be reclaimed. Keep active cache and all other
    // charges in the working set, as Docker's memory display does.
    return { limitBytes: limit, currentBytes: current, workingBytes: Math.max(0, current - stat[inactiveKey]) };
  }
  return null;
}

function createRenderMemory({ read = readCgroupMemory, initialWorkerBytes = 512 * MIB } = {}) {
  let snapshot, readFailed = false, blocked = false, pauses = 0;
  let peakWorkingBytes = 0, peakCurrentBytes = 0;
  const peaks = [];
  function refresh() {
    try {
      snapshot = read(); readFailed = false;
      peakWorkingBytes = Math.max(peakWorkingBytes, snapshot?.workingBytes || 0);
      peakCurrentBytes = Math.max(peakCurrentBytes, snapshot?.currentBytes || 0);
    }
    catch { readFailed = true; } // Keep the last known limit and stop admissions.
  }
  refresh();
  function estimate(workers) {
    const observed = Math.max(0, ...peaks, ...workers.map(w => w.peakFootprintBytes ?? w.peakRssBytes ?? 0));
    return Math.max(256 * MIB, peaks.length < 4 ? initialWorkerBytes : 0, Math.ceil(observed * 1.25));
  }
  function canStart(active, workers, idleFootprint = 0) {
    refresh();
    if (!snapshot && !readFailed) { blocked = false; return true; }
    const running = workers.filter(w => w.task);
    const budget = estimate(workers);
    // Queue slots are reserved synchronously, before their async work forks a
    // process. Count those slots too, so a cold burst cannot admit the full pool.
    const pending = Math.max(0, active - running.length);
    const reserved = pending * budget + running.reduce((sum, w) => sum + Math.max(0, budget - (w.footprintBytes ?? w.rssBytes ?? 0)), 0);
    const headroom = snapshot ? Math.max(512 * MIB, snapshot.limitBytes * 0.125) : Infinity;
    const allowed = !readFailed && snapshot.workingBytes + reserved + Math.max(0, budget - idleFootprint) <= snapshot.limitBytes - headroom;
    if (!allowed && !blocked) pauses++;
    blocked = !allowed;
    return allowed;
  }
  return {
    refresh, canStart,
    observePeak(bytes) { if (Number.isFinite(bytes) && bytes > 0) { peaks.push(bytes); if (peaks.length > 64) peaks.shift(); } },
    get pressure() { return !!snapshot && snapshot.workingBytes >= snapshot.limitBytes - Math.max(512 * MIB, snapshot.limitBytes * 0.125); },
    stats(workers = []) { return { enabled: !!snapshot || readFailed, ...snapshot, readFailed, limited: blocked, pauses,
      peakWorkingBytes, peakCurrentBytes, workerEstimateBytes: estimate(workers),
      headroomBytes: snapshot ? Math.max(512 * MIB, snapshot.limitBytes * 0.125) : null }; },
  };
}
module.exports = { createRenderMemory, readCgroupMemory };
