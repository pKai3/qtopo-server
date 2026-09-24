'use strict';
const $ = id => document.getElementById(id);
const refreshMs = 250;
const text = (element, value) => { if (element.textContent !== String(value)) element.textContent = value; };
const number = value => Number.isFinite(value) ? value.toLocaleString() : '—';
const ms = value => Number.isFinite(value) ? value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s` : '—';
const bytes = value => value >= 1073741824 ? `${(value / 1073741824).toFixed(2)} GiB` : `${(value / 1048576).toFixed(1)} MiB`;
function rows(element, values, definition = false) {
  if (!element.children.length) {
    element.replaceChildren(...values.flatMap(values => {
      if (definition) return values.map((_, index) => document.createElement(index ? 'dd' : 'dt'));
      const row = document.createElement('tr');
      row.append(...values.map(() => document.createElement('td')));
      return [row];
    }));
  }
  const cells = definition ? [...element.children] : [...element.querySelectorAll('td')];
  values.flat().forEach((value, index) => text(cells[index], value));
}
function stack(id, counts, capacity) {
  const total = counts.requested + counts.neighbours + counts.zoom;
  const scale = Math.max(1, capacity, total);
  for (const key of ['requested', 'neighbours', 'zoom']) {
    const segment = $(`${id}-${key}`), width = `${100 * counts[key] / scale}%`;
    if (segment.style.width !== width) segment.style.width = width;
    text($(`${id}-${key}-count`), number(counts[key]));
  }
  const remaining = Math.max(0, capacity - total);
  $(`${id}-stack`).setAttribute('aria-label', `${id === 'rendering' ? 'Rendering' : 'Waiting'}: ${counts.requested} requested, ${counts.neighbours} nearby prefetch, ${counts.zoom} zoom prefetch. ${remaining} ${id === 'rendering' ? 'idle workers' : 'unused queue spaces'}.`);
  text($(`${id}-total`), id === 'rendering' ? `${number(total)} of ${number(capacity)} workers busy` : `${number(total)} tiles waiting`);
  text($(`${id}-space`), id === 'rendering' ? `${number(remaining)} idle ${remaining === 1 ? 'worker' : 'workers'} · grey space` : `Scale: ${number(capacity)} combined queue spaces · grey is unused`);
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
    $('activity').textContent = busy ? 'Working' : r.queued || p.queued ? 'Waiting' : 'Idle';
    text($('updated'), `Updated ${new Date().toLocaleTimeString()}`);
    $('error').hidden = true;
    $('workers').textContent = `${r.active} / ${r.concurrency}`;
    $('workers-detail').textContent = `${r.workers} processes · peak ${r.peakActive} busy`;
    $('workers-meter').style.width = `${100 * r.active / r.concurrency}%`;
    $('hit-rate').textContent = q.hitPercent == null ? '—' : `${q.hitPercent}%`;
    $('cache-detail').textContent = `${number(q.hits)} cached · ${number(q.misses)} required preparation`;
    const waiting = {
      requested: r.queuedByPriority.requested,
      neighbours: r.queuedByPriority.neighbours + p.queuedNeighbours,
      zoom: r.queuedByPriority.zoom + p.queuedZoom,
    };
    $('queued').textContent = number(r.queued + p.queued);
    $('queue-detail').textContent = `${waiting.requested} requested · ${waiting.neighbours + waiting.zoom} prefetch`;
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
    stack('rendering', r.activeByPriority, r.concurrency);
    stack('waiting', waiting, s.renderQueueLimit + (p.enabled ? s.prefetchQueueLimit : 0));
    $('prefetch').textContent = p.enabled ? `Radius ${s.prefetchRadius} · up to ${p.concurrency} workers · zoom prefetch ${p.zoomEnabled ? 'enabled, lowest priority' : 'disabled'}.` : 'Prefetch is disabled.';
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
  } finally { loading = false; if (!document.hidden) timer = setTimeout(refresh, refreshMs); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
refresh();

let logTimer, logLoading = false, logPaused = false, logCursor = 0, logSession, logEntries = [];
async function refreshLogs() {
  clearTimeout(logTimer);
  if (document.hidden || !$('logs-panel').open || logPaused || logLoading) return;
  logLoading = true;
  try {
    const params = new URLSearchParams({ after: String(logCursor) });
    if (logSession) params.set('session', logSession);
    const response = await fetch('/api/logs?' + params, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json(), output = $('logs-output');
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    if (data.reset || data.truncated) logEntries = [];
    if (data.entries.length || data.reset) {
      logEntries = [...logEntries, ...data.entries].slice(-data.limit);
      output.textContent = logEntries.map(entry => entry.line).join('\n') || 'No application log entries yet.';
      if (follow || logCursor === 0) output.scrollTop = output.scrollHeight;
    } else if (!logCursor) output.textContent = 'No application log entries yet.';
    logCursor = data.next; logSession = data.session;
    text($('logs-status'), `${logPaused ? 'Paused' : 'Live'} · ${logEntries.length} recent entries${data.truncated ? ' · older entries have rotated out' : ''}`);
  } catch (error) {
    $('logs-status').textContent = `Could not refresh the log (${error.message}). Previously loaded entries are retained.`;
  } finally {
    logLoading = false;
    if (!document.hidden && $('logs-panel').open && !logPaused) logTimer = setTimeout(refreshLogs, refreshMs);
  }
}
$('logs-panel').addEventListener('toggle', () => { clearTimeout(logTimer); if ($('logs-panel').open) refreshLogs(); });
$('logs-pause').addEventListener('click', () => {
  logPaused = !logPaused; clearTimeout(logTimer);
  $('logs-pause').textContent = logPaused ? 'Resume' : 'Pause';
  $('logs-pause').setAttribute('aria-pressed', String(logPaused));
  $('logs-status').textContent = logPaused ? 'Paused · resume to load new entries' : 'Resuming…';
  if (!logPaused) refreshLogs();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(logTimer); else refreshLogs(); });
