'use strict';
(() => {
  const panel = document.getElementById('map-activity');
  const message = document.getElementById('map-activity-message');
  const tiers = ['requested', 'neighbours', 'zoom'];
  const rows = Object.fromEntries(['rendering', 'waiting'].map(name => [name, {
    bar: document.getElementById(`map-${name}-bar`),
    total: document.getElementById(`map-${name}-total`),
  }]));
  const count = value => Number.isFinite(value) ? Math.max(0, value) : 0;
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const visible = () => panel.open && !document.hidden;
  let timer, controller;

  function draw(name, counts, capacity) {
    const row = rows[name], values = tiers.map(tier => count(counts[tier]));
    const total = values.reduce((sum, value) => sum + value, 0), scale = Math.max(1, capacity, total);
    for (const [index, segment] of [...row.bar.children].entries()) segment.style.width = `${100 * values[index] / scale}%`;
    const label = name === 'rendering' ? 'Rendering' : 'Waiting';
    const detail = `${label}: ${values[0]} requested, ${values[1]} nearby prefetch, ${values[2]} zoom prefetch. Capacity ${capacity}.`;
    row.bar.setAttribute('aria-label', detail); row.bar.title = detail;
    text(row.total, name === 'rendering' ? `${total.toLocaleString()} / ${capacity.toLocaleString()}` : total.toLocaleString());
  }

  function unavailable() {
    for (const [name, row] of Object.entries(rows)) {
      text(row.total, '—');
      for (const segment of row.bar.children) segment.style.width = '0%';
      row.bar.setAttribute('aria-label', `${name === 'rendering' ? 'Rendering' : 'Waiting'}: activity unavailable`);
      row.bar.removeAttribute('title');
    }
    text(message, 'Activity unavailable. Retrying…'); message.hidden = false;
  }

  async function refresh() {
    clearTimeout(timer);
    if (!visible() || controller) return;
    const request = new AbortController(); controller = request;
    let timedOut = false, delay = 250;
    const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 10000);
    try {
      const response = await fetch('/readyz', { cache: 'no-store', signal: request.signal });
      // A degraded server still reports useful queue activity.
      if (!response.ok && response.status !== 503) throw new Error('Activity unavailable');
      const data = await response.json(), r = data.renderer, p = data.prefetch, s = data.settings;
      if (!r?.activeByPriority || !r.queuedByPriority || !p || !s) throw new Error('Activity unavailable');
      if (!visible() || request.signal.aborted) return;
      draw('rendering', r.activeByPriority, count(r.concurrency));
      draw('waiting', {
        requested: r.queuedByPriority.requested,
        neighbours: count(r.queuedByPriority.neighbours) + count(p.queuedNeighbours),
        zoom: count(r.queuedByPriority.zoom) + count(p.queuedZoom),
      }, count(s.renderQueueLimit) + (p.enabled ? count(s.prefetchQueueLimit) : 0));
      message.hidden = true;
    } catch {
      if (visible() && (!request.signal.aborted || timedOut)) { unavailable(); delay = 2000; }
    } finally {
      clearTimeout(timeout); controller = null;
      if (visible()) timer = setTimeout(refresh, delay);
    }
  }

  function sync() {
    clearTimeout(timer);
    if (visible()) refresh();
    else controller?.abort();
  }
  try { panel.open = localStorage.getItem('qtopo-map-activity-open') !== '0'; } catch {}
  panel.addEventListener('toggle', () => {
    try { localStorage.setItem('qtopo-map-activity-open', panel.open ? '1' : '0'); } catch {}
    sync();
  });
  document.addEventListener('visibilitychange', sync);
  sync();
})();
