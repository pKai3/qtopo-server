const phases = new Set(['starting', 'downloading', 'preparing', 'assembling', 'ready', 'error', 'waiting-space', 'disabled']);
const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
function downloadProgress(downloaded, total) {
  const unit = Math.max(downloaded, total) >= 1e9 ? ['GB', 1e9] : ['MB', 1e6];
  const amount = bytes => (bytes / unit[1]).toFixed(1);
  if (total) return `${amount(downloaded)} / ${amount(total)} ${unit[0]}`;
  return downloaded ? `${amount(downloaded)} ${unit[0]}` : '';
}

export function formatContourStatus(data) {
  if (!data || typeof data.enabled !== 'boolean' || typeof data.available !== 'boolean' || !phases.has(data.phase)) {
    throw new Error('Preparation status unavailable');
  }
  if (!data.enabled || data.phase === 'disabled') return { text: '', hidden: true, state: '' };
  const completed = count(data.completedSheets), total = count(data.totalSheets);
  const sheets = total && completed <= total ? `${completed}/${total} prepared` : completed ? `${completed} prepared` : '';
  const bytes = downloadProgress(count(data.downloadedBytes), count(data.totalBytes));
  const labels = {
    starting: 'starting preparation', downloading: `downloading${bytes ? ' ' + bytes : ''}`,
    preparing: 'preparing contours', assembling: 'assembling map',
    ready: data.available ? 'ready · used by Readable' : 'finishing preparation',
    error: data.nextRetryAt ? 'preparation paused · retrying automatically' : 'preparation paused',
    'waiting-space': 'waiting for free space',
  };
  const prefix = data.available && data.phase !== 'ready' ? 'NSW 2 m update' : 'NSW 2 m';
  let detail = !['ready', 'error', 'waiting-space'].includes(data.phase) && sheets ? ` · ${sheets}` : '';
  if (data.phase === 'assembling' && data.assembly) {
    const a = data.assembly, totalTiles = count(a.totalInputTiles), processed = count(a.inputTiles);
    const stages = { 'checking-inputs': 'checking assembly inputs', merging: 'merging map tiles', validating: 'validating merged map',
      hashing: 'checking map checksum', publishing: 'publishing map' };
    if (Object.hasOwn(stages, a.stage)) {
      labels.assembling = stages[a.stage];
      detail = '';
      if (a.stage === 'checking-inputs' && count(a.totalFiles)) detail = ` · ${Math.min(count(a.checkedFiles), count(a.totalFiles))}/${count(a.totalFiles)}`;
      else if (a.stage === 'merging' && a.countersAvailable === true && totalTiles && processed <= totalTiles) detail = ` · ${(100 * processed / totalTiles).toFixed(1)}%`;
      else if (count(a.outputBytes)) detail = ` · ${(a.outputBytes / 1e9).toFixed(1)} GB`;
    }
  }
  return { text: `${prefix}: ${labels[data.phase]}${detail}`, hidden: false,
    state: ['error', 'waiting-space'].includes(data.phase) ? 'paused' : '' };
}

// Refresh profile metadata and append published choices without changing the
// selected appearance. Its contour revision lets the viewer refresh in place.
export function addAvailableProfiles(select, current, incoming) {
  const selected = select.value, merged = [...current], known = new Map(current.map((profile, index) => [profile.id, index]));
  for (const profile of incoming) {
    if (!profile || typeof profile.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(profile.id)
        || typeof profile.name !== 'string' || !profile.name.trim()) continue;
    if (known.has(profile.id)) { merged[known.get(profile.id)] = { ...profile }; continue; }
    known.set(profile.id, merged.length); merged.push(profile);
    if (profile.hidden) continue;
    const option = select.ownerDocument.createElement('option');
    option.value = profile.id; option.textContent = profile.name; select.add(option);
  }
  select.value = selected;
  return merged;
}

export function attachContourStatus({ element, panel, document: doc = globalThis.document, fetchImpl = globalThis.fetch,
  available = false, revision, onProfiles = () => {}, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  if (!element || !doc) return { destroy() {} };
  let timer, controller, stopped = false, catalogReady = available, catalogRevision = revision;
  // Readable must adopt a publication even with its controls collapsed.
  const visible = () => !stopped && !doc.hidden;
  function draw(value) {
    if (element.textContent !== value.text) element.textContent = value.text;
    element.hidden = value.hidden; element.dataset.state = value.state;
  }
  async function refresh() {
    clearTimer(timer); timer = undefined;
    if (!visible() || controller) return;
    const request = new AbortController(); controller = request;
    let timedOut = false;
    const timeout = setTimer(() => { timedOut = true; request.abort(); }, 10000);
    try {
      const response = await fetchImpl('/api/contours', { cache: 'no-store', signal: request.signal });
      if (!response.ok) throw new Error('Preparation status unavailable');
      const data = await response.json(), formatted = formatContourStatus(data);
      if (!visible() || request.signal.aborted) return;
      draw(formatted);
      if (!data.available || !data.enabled) catalogReady = false;
      if (data.enabled && data.phase !== 'disabled' && data.available && (!catalogReady || data.revision !== catalogRevision)) {
        try {
          const result = await fetchImpl('/api/providers', { cache: 'no-store', signal: request.signal });
          if (!result.ok) throw new Error('Appearance list unavailable');
          const catalog = await result.json();
          if (!Array.isArray(catalog.profiles) || !catalog.profiles.some(profile => profile?.id === 'nsw-2m')) throw new Error('Appearance list is not ready');
          if (!visible() || request.signal.aborted) return;
          onProfiles(catalog.profiles); catalogReady = true; catalogRevision = data.revision;
        } catch {
          if (visible() && (!request.signal.aborted || timedOut)) draw({ text: 'NSW 2 m: ready · updating Appearance…', hidden: false, state: '' });
        }
      }
    } catch {
      if (visible() && (!request.signal.aborted || timedOut)) draw({ text: 'NSW 2 m: status unavailable · retrying', hidden: false, state: '' });
    } finally {
      clearTimer(timeout); controller = null;
      if (visible()) timer = setTimer(refresh, 5000);
    }
  }
  function sync() {
    clearTimer(timer); timer = undefined;
    if (visible()) refresh();
    else controller?.abort();
  }
  panel?.addEventListener('toggle', sync);
  doc.addEventListener('visibilitychange', sync);
  sync();
  return { destroy() {
    stopped = true; clearTimer(timer); controller?.abort();
    panel?.removeEventListener('toggle', sync);
    doc.removeEventListener('visibilitychange', sync);
  } };
}
