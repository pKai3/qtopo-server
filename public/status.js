'use strict';
const $ = id => document.getElementById(id);
const number = value => Number.isFinite(value) ? value.toLocaleString() : '—';
const ms = value => Number.isFinite(value) ? value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s` : '—';
const bytes = value => value >= 1073741824 ? `${(value / 1073741824).toFixed(2)} GiB` : `${(value / 1048576).toFixed(1)} MiB`;
function rows(element, values, definition = false) {
  element.replaceChildren(...values.flatMap(values => {
    if (definition) return values.map((value, index) => { const cell = document.createElement(index ? 'dd' : 'dt'); cell.textContent = value; return cell; });
    const row = document.createElement('tr');
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    return [row];
  }));
}
let previous, timer, loading = false;
async function refresh() {
  clearTimeout(timer);
  if (document.hidden || loading) return;
  loading = true;
  try {
    const response = await fetch('/readyz', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const r = data.renderer, c = data.cache, p = data.prefetch, q = data.requests, s = data.settings;
    const busy = q.active || r.active || c.activeDownloads;
    $('activity').textContent = busy ? 'Working' : 'Idle';
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    $('error').hidden = true;
    $('workers').textContent = `${r.active} / ${r.concurrency}`;
    $('workers-detail').textContent = `${r.workers} processes · peak ${r.peakActive} busy`;
    $('workers-meter').style.width = `${100 * r.active / r.concurrency}%`;
    $('hit-rate').textContent = q.hitPercent == null ? '—' : `${q.hitPercent}%`;
    $('cache-detail').textContent = `${number(q.hits)} cached · ${number(q.misses)} required preparation`;
    $('queued').textContent = number(r.queued);
    $('queue-detail').textContent = r.queued ? `Oldest waiting ${ms(r.oldestQueuedMs)}` : 'No render backlog';
    $('downloads').textContent = `${c.activeDownloads} / ${s.upstreamConcurrency}`;
    $('download-detail').textContent = `${number(c.downloads.queued)} queued · ${number(c.errors)} errors since restart`;
    const summaries = [
      ['Cached tile ready', q.cachedTimings.readyMs], ['Cached response', q.cachedTimings.responseMs],
      ['All tile responses', q.timings.responseMs], ['Render queue', r.timings.queueMs],
      ['Worker elapsed', r.timings.workerMs], ['Resource waiting', r.timings.resourceWaitMs],
      ['PNG encoding', r.timings.encodeMs], ['Worker CPU', r.timings.cpuMs],
    ];
    rows($('timings'), summaries.map(([label, value]) => [label, ms(value?.p50), ms(value?.p95)]));
    $('samples').textContent = `Recent samples: ${q.cachedTimings.samples} cached responses, ${q.timings.samples} total responses, ${r.timings.samples} renders. Each window holds up to 256 samples.`;
    rows($('priorities'), [['Requested tiles', 'requested'], ['Nearby prefetch', 'neighbours'], ['Zoom prefetch', 'zoom']].map(([label, key]) => [label, number(r.activeByPriority[key]), number(r.queuedByPriority[key])]));
    $('prefetch').textContent = p.enabled ? `Radius ${s.prefetchRadius} · ${p.active} in progress · ${p.queuedNeighbours} nearby and ${p.queuedZoom} zoom tiles pending.` : 'Prefetch is disabled.';
    $('prefetch-use').textContent = `${number(p.completed)} prefetch checks completed; ${number(q.prefetchUsed)} subsequently served from cache to clients. Reuse tracking covers the most recent 1,024 newly prefetched files.`;
    const now = performance.now();
    const rate = previous?.startedAt === data.startedAt ? `${Math.max(0, (q.completed - previous.completed) * 1000 / (now - previous.time)).toFixed(1)} tiles/s` : '—';
    previous = { startedAt: data.startedAt, completed: q.completed, time: now };
    rows($('session'), [['Active tile requests', number(q.active)], ['Completed responses', number(q.completed)], ['Recent delivery rate', rate], ['PNG data sent', bytes(q.bytes)], ['Failed responses', number(q.errors)], ['Client disconnects', number(q.disconnected)]], true);
    rows($('settings'), [['Tile resolution', `${s.tilePx} × ${s.tilePx}`], ['PNG compression', `${s.pngCompression} / 9 · lossless`], ['Render concurrency', number(s.renderConcurrency)], ['Prefetch concurrency', number(s.prefetchConcurrency)], ['Render queue limit', number(s.renderQueueLimit)], ['Download concurrency', number(s.upstreamConcurrency)], ['Zoom prefetch', s.prefetchZoom && s.prefetchRadius ? 'Enabled · lowest priority' : 'Disabled'], ['Started', new Date(data.startedAt).toLocaleString()]], true);
    $('release').textContent = `QTopo ${data.version} · ${data.revision.slice(0, 12)}`;
  } catch (error) {
    $('activity').textContent = 'Unavailable';
    $('error').textContent = `Could not refresh server activity (${error.message}). Any figures shown are from the last successful update.`;
    $('error').hidden = false;
  } finally { loading = false; if (!document.hidden) timer = setTimeout(refresh, 5000); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
refresh();
