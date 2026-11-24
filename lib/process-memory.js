const fs = require('node:fs');

function readProcessMemory(pid = 'self', read = file => fs.readFileSync(file, 'utf8')) {
  const status = read(`/proc/${pid}/status`);
  const bytes = key => {
    const match = status.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm'));
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const rssBytes = bytes('VmRSS');
  if (!Number.isFinite(rssBytes)) throw new Error('Invalid process memory reading');
  const anon = bytes('RssAnon'), shared = bytes('RssShmem');
  // Shared file/library pages already belong to the container working set.
  // Reserving them again for every worker substantially understates capacity.
  // Keep shared anonymous memory charged in full; fall back to RSS on old kernels.
  return { rssBytes, footprintBytes: anon === undefined || shared === undefined ? rssBytes : anon + shared };
}

function createJobMemory(read = () => readProcessMemory()) {
  let rssBytes = 0, footprintBytes = 0, peakRssBytes = 0, peakFootprintBytes = 0;
  function sample() {
    try {
      ({ rssBytes, footprintBytes } = read());
      peakRssBytes = Math.max(peakRssBytes, rssBytes);
      peakFootprintBytes = Math.max(peakFootprintBytes, footprintBytes);
    } catch { // Non-Linux rendering still works; RSS is a conservative fallback.
      rssBytes = footprintBytes = process.memoryUsage.rss();
      peakRssBytes = Math.max(peakRssBytes, rssBytes);
      peakFootprintBytes = Math.max(peakFootprintBytes, footprintBytes);
    }
    return { rssBytes, footprintBytes, peakRssBytes, peakFootprintBytes };
  }
  return { sample };
}
module.exports = { readProcessMemory, createJobMemory };
