// Repeated pans under a real Docker memory cap. A single successful render does
// not catch native allocator retention, which can stall the display without OOM.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const origin = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const counters = text => Object.fromEntries(text.trim().split('\n').map(line => {
  const [key, value] = line.split(/\s+/); return [key, Number(value)];
}));
async function status() {
  const res = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 200); return res.json();
}
async function main() {
  await fs.mkdir('/tmp/smoke', { recursive: true });
  const limit = Number(await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8'));
  assert.equal(limit, 4 * 1024 ** 3, 'exercise the deployed 4 GiB memory budget');
  let before;
  for (let i = 0; i < 60; i++) {
    try { before = await status(); break; } catch (err) { if (i === 59) throw err; }
    await sleep(500);
  }
  assert.equal(before.settings.renderConcurrency, 24);
  assert.equal(before.renderer.memory.enabled, true);
  const initialEvents = counters(await fs.readFile('/sys/fs/cgroup/memory.events', 'utf8'));
  const report = { limit, samples: 0, peakCurrent: 0, peakAnonymous: 0, pans: [], history: [] };
  let stop = false;
  const monitor = (async () => {
    while (!stop) {
      const current = Number(await fs.readFile('/sys/fs/cgroup/memory.current', 'utf8'));
      const memory = counters(await fs.readFile('/sys/fs/cgroup/memory.stat', 'utf8'));
      report.samples++;
      report.peakCurrent = Math.max(report.peakCurrent, current);
      report.peakAnonymous = Math.max(report.peakAnonymous, memory.anon);
      if (report.samples % 10 === 0) report.history.push({ elapsedMs: Date.now() - Date.parse(before.startedAt), current, anonymous: memory.anon });
      await sleep(100);
    }
  })();
  // Observe monitor failures promptly; await it again in finally to propagate.
  monitor.catch(() => { stop = true; });
  try {
    for (let pan = 0; pan < 16; pan++) {
      const [profile, z, baseX, baseY] = [
        ['readable', 14, 15110, 9494], ['mobile-light', 15, 30280, 18988],
        ['mobile-3x', 16, 60580, 37976], ['readable', 15, 30280, 19004],
      ][pan % 4];
      const x = baseX + Math.floor(pan / 4) * 8;
      const started = Date.now();
      // Twenty-four distinct grids demand the full configured pool. Repeated zoom
      // and style changes exercise both retained maps and fresh allocations.
      // Prefetch remains enabled and overlaps subsequent pans.
      await Promise.all(Array.from({ length: 24 }, async (_, i) => {
        const res = await fetch(`${origin}/${profile}/${z}/${x + (i % 4) * 2}/${baseY + Math.floor(i / 4) * 2}.png`, {
          signal: AbortSignal.timeout(120000),
        });
        assert.equal(res.status, 200);
        const png = Buffer.from(await res.arrayBuffer());
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), 1024); assert.equal(png.readUInt32BE(20), 1024);
      }));
      const current = await status();
      assert.equal(current.startedAt, before.startedAt, 'the server must not restart during panning');
      report.pans.push({ profile, z, x, ms: Date.now() - started, completedRenders: current.renderer.completed,
        active: current.renderer.active, queue: current.renderer.timings.queueMs, requestedQueue: current.renderer.requestedTimings.queueMs,
        yieldedPrefetch: current.renderer.yieldedPrefetch, preemptedForMemory: current.renderer.preemptedForMemory, memory: current.renderer.memory });
      console.log('Memory pan:', JSON.stringify(report.pans.at(-1)));
    }
    let after;
    for (let i = 0; i < 180; i++) {
      after = await status();
      if (!after.renderer.active && !after.renderer.queued && !after.prefetch.tracked) break;
      await sleep(500);
    }
    assert.equal(after.renderer.active + after.renderer.queued + after.prefetch.tracked, 0, 'background work must finish');
    assert.equal(after.startedAt, before.startedAt);
    assert.ok(after.renderer.peakActive > 1 && after.renderer.peakActive <= 24, 'admission adapts below the configured ceiling');
    assert.ok(after.renderer.memory.pauses > 0, 'must exercise memory-aware backpressure');
    assert.equal(after.renderer.memory.limited, false, 'idle status must clear after draining');
    assert.equal(after.requests.errors, 0);
    assert.ok(after.renderer.recycledForMemory + after.renderer.memory.releasedIdleWorkers > 0, 'must exercise release of retained native memory');
    report.after = after;
    report.events = counters(await fs.readFile('/sys/fs/cgroup/memory.events', 'utf8'));
    assert.equal(report.events.oom, initialEvents.oom, 'no allocation failures');
    assert.equal(report.events.oom_kill, initialEvents.oom_kill, 'no killed workers');
    // File cache is reclaimable. Anonymous allocations need headroom or the
    // watchdog can time out during reclaim even without an OOM kill.
    assert.ok(report.peakAnonymous < limit * 0.9, `anonymous memory approached the limit: ${report.peakAnonymous}`);
  } finally {
    stop = true;
    try { await monitor; }
    finally { await fs.writeFile('/tmp/smoke/memory.json', JSON.stringify(report, null, 2)); }
  }
  console.log('Twenty-four-worker memory admission check:', JSON.stringify({ peakCurrent: report.peakCurrent, peakAnonymous: report.peakAnonymous, events: report.events }));
}
main().catch(error => { console.error(error); process.exit(1); });
