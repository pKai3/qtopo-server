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

// Keep unlike styles/zooms separate: a dense zoom-prefetch must not set the
// reservation for every later foreground tile. Bound both history dimensions.
const memoryKey = job => JSON.stringify([job?.kind, job?.styleKey, job?.z, job?.size]);
const footprint = worker => worker?.footprintBytes ?? worker?.rssBytes ?? 0;
function createRenderMemory({ read = readCgroupMemory, enabled = true, initialWorkerBytes = 512 * MIB,
  headroomBytes = 512 * MIB, headroomPercent = 12.5 } = {}) {
  let snapshot, readFailed = false, blocked = false, pauses = 0;
  let peakWorkingBytes = 0, peakCurrentBytes = 0, reservedBytes = 0, foregroundReserveBytes = 0;
  const history = new Map(), recent = [];
  const headroom = () => snapshot ? Math.max(headroomBytes, snapshot.limitBytes * headroomPercent / 100) : Infinity;
  function refresh() {
    try {
      snapshot = read(); readFailed = false;
      peakWorkingBytes = Math.max(peakWorkingBytes, snapshot?.workingBytes || 0);
      peakCurrentBytes = Math.max(peakCurrentBytes, snapshot?.currentBytes || 0);
    } catch { readFailed = true; }
  }
  refresh();
  function estimate(job, workers = []) {
    const key = memoryKey(job), peaks = history.get(key) || [];
    const runningPeaks = workers.filter(w => w.task && memoryKey(w.task.job) === key)
      .map(w => w.peakFootprintBytes ?? w.peakRssBytes ?? 0);
    // The shared 512 MiB+ headroom covers unobserved growth. Adding another
    // 25% to every worker peak held back over a GiB in a sixteen-worker pool.
    return Math.ceil(Math.max(128 * MIB, peaks.length < 4 ? Math.max(initialWorkerBytes, ...recent) : 0,
      ...peaks, ...runningPeaks));
  }
  function canStart({ active = [], workers = [], idle = [], job = {}, reserveForeground = false } = {}) {
    refresh();
    reservedBytes = foregroundReserveBytes = 0;
    if (!enabled) { blocked = false; return true; }
    if (!snapshot && !readFailed) { blocked = false; return true; }
    const running = workers.filter(w => w.task), assigned = new Set(running.map(w => w.task.job));
    reservedBytes = running.reduce((sum, w) => sum + Math.max(0, estimate(w.task.job, workers) - footprint(w)), 0);
    // Pending admissions will take distinct idle workers. Their retained memory
    // is already charged by the cgroup and must not be reserved a second time.
    const budgets = [...active.filter(j => !assigned.has(j)), job].map(j => estimate(j, workers));
    if (reserveForeground) budgets.push(estimate(job, workers));
    // Async cache checks can dispatch pending jobs in a different order. Pair
    // the largest budget with the smallest retained worker, reserving the worst
    // possible assignment instead of relying on future callback order.
    const retained = idle.slice(-budgets.length).map(footprint).sort((a, b) => a - b);
    while (retained.length < budgets.length) retained.unshift(0);
    budgets.sort((a, b) => b - a);
    reservedBytes += budgets.reduce((sum, budget, i) => sum + Math.max(0, budget - retained[i]), 0);
    if (reserveForeground) foregroundReserveBytes = estimate(job, workers);
    const allowed = !readFailed && snapshot.workingBytes + reservedBytes <= snapshot.limitBytes - headroom();
    if (!allowed && !blocked) pauses++;
    blocked = !allowed;
    return allowed;
  }
  return {
    refresh, canStart,
    observePeak(bytes, job) {
      if (!Number.isFinite(bytes) || bytes <= 0) return;
      const key = memoryKey(job), peaks = history.get(key) || [];
      peaks.push(bytes); if (peaks.length > 32) peaks.shift();
      history.delete(key); history.set(key, peaks);
      if (history.size > 128) history.delete(history.keys().next().value);
      recent.push(bytes); if (recent.length > 64) recent.shift();
    },
    get pressure() { return enabled && !!snapshot && snapshot.workingBytes >= snapshot.limitBytes - headroom(); },
    stats(workers = []) { return { enabled: enabled && (!!snapshot || readFailed), guardEnabled: enabled, ...snapshot, readFailed, limited: blocked, pauses,
      peakWorkingBytes, peakCurrentBytes, workerEstimateBytes: Math.max(recent.length ? 128 * MIB : initialWorkerBytes, ...recent, ...workers.filter(w => w.task).map(w => estimate(w.task.job, workers))),
      reservedBytes, foregroundReserveBytes, headroomBytes: snapshot ? headroom() : null }; },
  };
}
module.exports = { createRenderMemory, readCgroupMemory };
