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
  text($(`${id}-total`), id === 'rendering' ? `${number(total)} of ${number(capacity)} workers busy` : `${number(total)} work items waiting`);
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
      ['First tile ready', r.timings.firstTileMs], ['Worker elapsed', r.timings.workerMs], ['Resource waiting', r.timings.resourceWaitMs],
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
    rows($('settings'), [['Tile resolution', `${s.tilePx} × ${s.tilePx}`], ['Vector render grid', `${s.metatileSize} × ${s.metatileSize} tiles`], ['Render border', `${s.renderBufferPx * s.tilePx / 512}px at this resolution`], ['PNG compression', `${s.pngCompression} / 9 · lossless`], ['Render concurrency', number(s.renderConcurrency)], ['Prefetch concurrency', number(s.prefetchConcurrency)], ['Render queue limit', number(s.renderQueueLimit)], ['Download concurrency', number(s.upstreamConcurrency)], ['Zoom prefetch', s.prefetchZoom && s.prefetchRadius ? 'Enabled · lowest priority' : 'Disabled'], ['Started', new Date(data.startedAt).toLocaleString()]], true);
    $('release').textContent = `QTopo ${data.version} · ${data.revision.slice(0, 12)}`;
    if (data.actions) renderActions(data.actions);
  } catch (error) {
    $('activity').textContent = 'Unavailable';
    $('error').textContent = `Could not refresh server activity (${error.message}). Any figures shown are from the last successful update.`;
    $('error').hidden = false;
  } finally { loading = false; if (!document.hidden) timer = setTimeout(refresh, refreshMs); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });

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

let actionPending = false, actionState = { test: { phase: 'idle' }, clearing: { phase: 'idle' } }, testSession;
const testBusy = () => ['running', 'stopping'].includes(actionState.test.phase);
const clearingBusy = () => ['waiting', 'clearing'].includes(actionState.clearing.phase);
function updateArea() {
  const values = Object.fromEntries(['width', 'height', 'concurrency'].map(key => [key, $('test-form').elements.namedItem(key).value]));
  text($('test-area'), `${number(Number(values.width) * Number(values.height))} tiles · up to ${values.concurrency} requests at once`);
}
function renderActions(state) {
  actionState = state;
  const t = state.test, c = state.clearing, busy = testBusy(), clearing = clearingBusy();
  // Restore the active test after a reload or when another browser starts it.
  if (t.startedAt && t.startedAt !== testSession) {
    testSession = t.startedAt;
    for (const [key, value] of Object.entries(t.settings)) {
      if ($('test-form').elements.namedItem(key)) $('test-form').elements.namedItem(key).value = value;
    }
    updateArea();
  }
  $('test-fields').disabled = busy || clearing || actionPending;
  $('test-start').disabled = busy || clearing || actionPending;
  $('test-stop').disabled = t.phase !== 'running' || actionPending;
  $('cache-clear').disabled = busy || clearing || actionPending;
  $('cache-confirm-clear').disabled = busy || clearing || actionPending;
  text($('test-phase'), { idle: 'Ready', running: 'Running', stopping: 'Finishing requests', complete: 'Finished', stopped: 'Stopped', error: 'Failed' }[t.phase]);
  const p = t.result || t.progress;
  if (p) {
    const finished = p.succeeded + p.failed;
    $('test-progress').max = p.requested;
    $('test-progress').value = finished;
    text($('test-message'), `${finished} of ${p.requested} finished · ${p.succeeded} received · ${p.failed} failed${p.skipped ? ` · ${p.skipped} skipped` : ''}${busy ? ` · ${p.active || 0} requests in flight` : ''}${t.phase === 'stopping' ? ' · no new requests will start' : ''}`);
    rows($('test-results'), [['Elapsed', ms(p.elapsedMs)], ['PNG data received', bytes(p.bytes)], ['Peak parallel requests', number(p.peakRequests)], ['Peak busy render jobs observed', number(p.peakRenderJobsObserved)], ['Median response', ms(p.medianMs)], ['95th percentile response', ms(p.p95Ms)], ['Server cache hits during test', number(p.serverCacheHits)], ['Server cache misses during test', number(p.serverCacheMisses)]], true);
  } else {
    $('test-progress').value = 0; $('test-results').replaceChildren();
    text($('test-message'), 'No test has been run. The request limit does not change the configured render worker count.');
  }
  if (t.error) text($('test-message'), `Test failed: ${t.error}`);
  const failures = t.result?.failures || [];
  text($('test-output'), [...(t.logs || []), ...failures.map(f => `${f.route}: ${f.error}`), failures.length ? 'Up to 10 failures shown.' : ''].filter(Boolean).join('\n') || 'No test output yet.');
  text($('cache-message'), c.phase === 'waiting' ? 'Waiting for current requests and render jobs to finish…' : c.phase === 'clearing' ? `Clearing… ${number(c.removed)} tiles removed.` : c.phase === 'done' ? `Cleared ${number(c.removed)} rendered tiles (${bytes(c.bytes)}). New requests can render them again.` : c.phase === 'error' ? `Could not finish clearing: ${c.error}` : busy ? 'Stop the test and let its current requests finish before clearing the cache.' : '');
}
async function performAction(route, body = {}) {
  actionPending = true; $('action-error').hidden = true; renderActions(actionState);
  try {
    const response = await fetch('/api/actions/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-QTopo-Action': 'status-page' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderActions(data);
  } catch (error) {
    text($('action-error'), error.message); $('action-error').hidden = false;
  } finally { actionPending = false; renderActions(actionState); refresh(); }
}
$('test-form').addEventListener('input', updateArea);
$('test-form').addEventListener('submit', event => {
  event.preventDefault();
  if (actionPending || testBusy() || clearingBusy()) return;
  const settings = Object.fromEntries([...new FormData($('test-form'))].map(([key, value]) => [key, Number(value)]));
  performAction('tile-test/start', settings);
});
$('test-stop').addEventListener('click', () => performAction('tile-test/stop'));
$('cache-clear').addEventListener('click', () => { $('cache-confirm').hidden = false; $('cache-cancel').focus(); });
$('cache-cancel').addEventListener('click', () => { $('cache-confirm').hidden = true; $('cache-clear').focus(); });
$('cache-confirm-clear').addEventListener('click', () => {
  if (actionPending || testBusy() || clearingBusy()) return;
  $('cache-confirm').hidden = true;
  performAction('cache/clear', { confirm: 'clear-rendered-tiles' });
});
refresh();
