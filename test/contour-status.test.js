const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../public/contour-status.mjs');
const status = (changes = {}) => ({ enabled: true, available: false, phase: 'downloading', completedSheets: 42, totalSheets: 343,
  downloadedBytes: 8.1e9, totalBytes: 29.2e9, ...changes });
const response = value => ({ ok: true, json: async () => value });
const flush = () => new Promise(resolve => setImmediate(resolve));
const readable = { id: 'readable', name: 'Readable' }, mobile = { id: 'mobile', name: 'Mobile' };
const contours = { id: 'nsw-2m', name: 'NSW · 2 m contours' };

class Select extends EventTarget {
  constructor() {
    super(); this.value = 'mobile'; this.options = [readable, mobile].map(profile => ({ value: profile.id, textContent: profile.name }));
    this.ownerDocument = { createElement: name => { assert.equal(name, 'option'); return {}; } };
  }
  add(option) { this.options.push(option); }
}
async function harness(fetchImpl, options = {}) {
  const { attachContourStatus } = await modulePromise;
  const doc = new EventTarget(); doc.hidden = false;
  const panel = new EventTarget(); panel.open = true;
  const element = { textContent: '', hidden: true, dataset: {} }, timers = new Map();
  let next = 0;
  const control = attachContourStatus({ element, panel, document: doc, fetchImpl,
    setTimer: (fn, delay) => { timers.set(++next, { fn, delay }); return next; }, clearTimer: id => timers.delete(id), ...options });
  return { control, doc, panel, element, timers,
    async tick(delay = 5000) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `a ${delay} ms timer was scheduled`);
      timers.delete(entry[0]); entry[1].fn(); await flush();
    },
  };
}

test('preparation formatting separates transferred bytes, prepared sheets and final assembly', async () => {
  const { formatContourStatus: format } = await modulePromise;
  assert.equal(format(status()).text, 'NSW 2 m: downloading 8.1 / 29.2 GB · 42/343 prepared');
  assert.equal(format(status({ phase: 'preparing' })).text, 'NSW 2 m: preparing contours · 42/343 prepared');
  assert.equal(format(status({ phase: 'assembling', completedSheets: 343 })).text, 'NSW 2 m: assembling map · 343/343 prepared');
  assert.equal(format(status({ phase: 'ready', available: false })).text, 'NSW 2 m: finishing preparation');
  assert.equal(format(status({ phase: 'ready', available: true })).text, 'NSW 2 m: ready in Appearance');
  assert.equal(format(status({ totalBytes: 0, totalSheets: 0 })).text, 'NSW 2 m: downloading 8.1 GB · 42 prepared');
  assert.equal(format(status({ downloadedBytes: 8.1e6, totalBytes: 29.2e6 })).text, 'NSW 2 m: downloading 8.1 / 29.2 MB · 42/343 prepared');
  assert.equal(format(status({ available: true, phase: 'preparing' })).text, 'NSW 2 m update: preparing contours · 42/343 prepared');
});

test('disabled, paused and invalid status never expose private errors or filenames', async () => {
  const { formatContourStatus: format } = await modulePromise;
  assert.equal(format(status({ enabled: false })).hidden, true);
  assert.equal(format(status({ phase: 'disabled' })).hidden, true);
  const paused = format(status({ phase: 'error', nextRetryAt: '2026-11-27T00:00:00Z', currentSheet: '/private/file.zip', error: '<script>secret</script>' }));
  assert.deepEqual(paused, { text: 'NSW 2 m: preparation paused · retrying automatically', hidden: false, state: 'paused' });
  assert.equal(format(status({ phase: 'waiting-space' })).text, 'NSW 2 m: waiting for free space');
  assert.equal(format(status({ phase: 'starting', completedSheets: NaN, totalSheets: -1 })).text, 'NSW 2 m: starting preparation');
  for (const invalid of [null, {}, status({ phase: '/private/path' }), status({ available: 'yes' })]) assert.throws(() => format(invalid));
});

test('new appearance options preserve selection, do not fire change and are not duplicated', async () => {
  const { addAvailableProfiles } = await modulePromise, select = new Select();
  let changes = 0; select.addEventListener('change', () => changes++);
  const current = [readable, mobile];
  const merged = addAvailableProfiles(select, current, [readable, mobile, contours, contours, { id: '../bad', name: 'Invalid' }, { id: 'hidden', name: 'Hidden', hidden: true }]);
  assert.deepEqual(current, [readable, mobile], 'the original catalog snapshot is not mutated');
  assert.deepEqual(select.options.map(option => option.value), ['readable', 'mobile', 'nsw-2m']);
  assert.equal(select.value, 'mobile'); assert.equal(changes, 0);
  assert.equal(addAvailableProfiles(select, merged, [contours]).length, merged.length);
  assert.equal(select.options.length, 3);
});

test('visible progress polls every five seconds and publishes the new choice without changing the map selection', async t => {
  const { addAvailableProfiles } = await modulePromise;
  const select = new Select(), calls = []; let current = [readable, mobile], ready = false, changes = 0;
  select.addEventListener('change', () => changes++);
  const view = await harness(async (url, options) => {
    calls.push(url); assert.equal(options.cache, 'no-store');
    return response(url === '/api/contours' ? status(ready ? { phase: 'ready', available: true } : {}) : { profiles: [readable, mobile, contours] });
  }, { onProfiles: profiles => { current = addAvailableProfiles(select, current, profiles); } });
  t.after(() => view.control.destroy()); await flush();
  assert.equal(view.element.hidden, false);
  assert.equal(view.element.textContent, 'NSW 2 m: downloading 8.1 / 29.2 GB · 42/343 prepared');
  assert.deepEqual([...view.timers.values()].map(timer => timer.delay), [5000]);
  ready = true; await view.tick();
  assert.deepEqual(calls, ['/api/contours', '/api/contours', '/api/providers']);
  assert.equal(select.value, 'mobile'); assert.equal(changes, 0);
  assert.equal(select.options.at(-1).value, 'nsw-2m');
  await view.tick(); assert.equal(calls.filter(url => url === '/api/providers').length, 1);
  view.panel.open = false; view.panel.dispatchEvent(new Event('toggle'));
  assert.equal(view.timers.size, 0);
  const previous = calls.length;
  view.panel.open = true; view.panel.dispatchEvent(new Event('toggle')); await flush();
  assert.equal(calls.length, previous + 1, 'reopening controls refreshes status immediately');
});

test('a failed appearance refresh is retried while preparation remains ready', async t => {
  let attempts = 0, accepted = 0;
  const view = await harness(async url => {
    if (url === '/api/contours') return response(status({ phase: 'ready', available: true }));
    attempts++;
    return attempts === 1 ? { ok: false } : response({ profiles: [contours] });
  }, { onProfiles: () => accepted++ });
  t.after(() => view.control.destroy()); await flush();
  assert.equal(view.element.textContent, 'NSW 2 m: ready · updating Appearance…');
  assert.equal(accepted, 0); await view.tick();
  assert.equal(attempts, 2); assert.equal(accepted, 1);
  assert.equal(view.element.textContent, 'NSW 2 m: ready in Appearance');
});

test('hidden pages abort pending work and ignore late responses before resuming', async t => {
  let resolve, signal, calls = 0, accepted = 0;
  const view = await harness((_url, options) => {
    calls++; signal = options.signal;
    if (calls > 1) return Promise.resolve(response(status()));
    return new Promise(done => { resolve = done; });
  }, { onProfiles: () => accepted++ });
  t.after(() => view.control.destroy());
  view.doc.hidden = true; view.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(signal.aborted, true);
  resolve(response(status({ phase: 'ready', available: true }))); await flush();
  assert.equal(accepted, 0); assert.equal(view.element.hidden, true); assert.equal(view.timers.size, 0);
  view.doc.hidden = false; view.doc.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(calls, 2); assert.equal(view.element.hidden, false);
  view.control.destroy(); assert.equal(view.timers.size, 0);
  view.doc.dispatchEvent(new Event('visibilitychange')); await flush(); assert.equal(calls, 2);
});

test('connection failures and timeouts show a generic retry message and recover', async t => {
  let mode = 'timeout';
  const view = await harness((_url, { signal }) => {
    if (mode === 'timeout') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('/private/service/error'))));
    if (mode === 'error') return Promise.resolve({ ok: false });
    return Promise.resolve(response(status({ phase: 'disabled', enabled: false, available: true })));
  });
  t.after(() => view.control.destroy());
  await view.tick(10000);
  assert.equal(view.element.textContent, 'NSW 2 m: status unavailable · retrying');
  mode = 'error'; await view.tick(); assert.equal(view.element.textContent, 'NSW 2 m: status unavailable · retrying');
  mode = 'disabled'; await view.tick(); assert.equal(view.element.hidden, true);
});
