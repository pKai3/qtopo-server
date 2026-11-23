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
  assert.equal(before.settings.renderConcurrency, 8);
  const initialEvents = counters(await fs.readFile('/sys/fs/cgroup/memory.events', 'utf8'));
  const report = { limit, samples: 0, peakCurrent: 0, peakAnonymous: 0, pans: [] };
  let stop = false;
  const monitor = (async () => {
    while (!stop) {
      const current = Number(await fs.readFile('/sys/fs/cgroup/memory.current', 'utf8'));
      const memory = counters(await fs.readFile('/sys/fs/cgroup/memory.stat', 'utf8'));
      report.samples++;
      report.peakCurrent = Math.max(report.peakCurrent, current);
      report.peakAnonymous = Math.max(report.peakAnonymous, memory.anon);
      await sleep(100);
    }
  })();
  // Observe monitor failures promptly; await it again in finally to propagate.
  monitor.catch(() => { stop = true; });
  try {
    for (const x of [15110, 15118, 15126, 15134, 15142, 15150, 15158, 15166, 15174, 15182]) {
      const started = Date.now();
      // One request per 2x2 grid starts eight independent renders. Prefetch is
      // enabled as in production, and the next pan arrives before it goes idle.
      await Promise.all(Array.from({ length: 8 }, async (_, i) => {
        const res = await fetch(`${origin}/readable/14/${x + (i % 4) * 2}/${9528 + Math.floor(i / 4) * 2}.png`, {
          signal: AbortSignal.timeout(90000),
        });
        assert.equal(res.status, 200);
        const png = Buffer.from(await res.arrayBuffer());
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), 1024); assert.equal(png.readUInt32BE(20), 1024);
      }));
      const current = await status();
      assert.equal(current.startedAt, before.startedAt, 'the server must not restart during panning');
      report.pans.push({ x, ms: Date.now() - started, completedRenders: current.renderer.completed });
      console.log('Memory pan:', JSON.stringify(report.pans.at(-1)));
      await sleep(2000);
    }
    let after;
    for (let i = 0; i < 180; i++) {
      after = await status();
      if (!after.renderer.active && !after.renderer.queued && !after.prefetch.active && !after.prefetch.queued) break;
      await sleep(500);
    }
    assert.equal(after.renderer.active + after.renderer.queued + after.prefetch.active + after.prefetch.queued, 0, 'background work must finish');
    assert.equal(after.startedAt, before.startedAt);
    assert.equal(after.renderer.peakActive, 8, 'must exercise all eight native workers');
    assert.equal(after.requests.errors, 0);
    assert.ok(after.renderer.recycledForMemory > 0, 'must exercise replacement of retained native memory');
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
  console.log('Eight-worker memory check:', JSON.stringify({ peakCurrent: report.peakCurrent, peakAnonymous: report.peakAnonymous, events: report.events }));
}
main().catch(error => { console.error(error); process.exit(1); });
