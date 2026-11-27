const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../public/map-search.mjs');
const feature = (name, center = [152.7, -28.28], properties = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: center }, properties: { name, state: 'Queensland', country: 'Australia', ...properties } });
const response = features => ({ ok: true, json: async () => ({ features }) });

test('coordinate search accepts signed decimal and hemisphere/DMS pairs without guessing axis order', async () => {
  const { parseCoordinates } = await modulePromise;
  for (const value of ['-28.28, 152.70', '(-28.28; 152.70)', '[-28.28 152.70]', '−28.28,152.70', '28.28S 152.70E', 'S28.28 E152.70', 'E152.70 S28.28', '152.70E,28.28S', '28°16′48″S 152°42′00″E', 'S 28 16.8, E 152 42']) {
    const [lng, lat] = parseCoordinates(value);
    assert.ok(Math.abs(lat + 28.28) < 1e-10, value);
    assert.ok(Math.abs(lng - 152.7) < 1e-10, value);
  }
  assert.deepEqual(parseCoordinates('90, -180'), [-180, 90]);
  for (const value of ['Mount Barney', '1770', '10 George Street, Brisbane', 'New Norfolk']) assert.equal(parseCoordinates(value), null);
});

test('malformed coordinates stay local and produce useful errors', async () => {
  const { createPlaceSearch } = await modulePromise;
  const lookup = createPlaceSearch({ fetchImpl: () => assert.fail('Coordinates must not be sent to a geocoder') });
  for (const value of ['91, 153', '-28, 181', '153, -28', '28°60′S 152°E', '28°16′60″S 152°E', '90°1′N 153°E', '28S 152S', '-28N 152E', '+28S 152E', '28.5°10′S 152E', '28S', '-28.28', '28,153,12']) {
    await assert.rejects(lookup.search(value), /Latitude|Minutes|direction|latitude, longitude/);
  }
  await assert.rejects(lookup.search(' '), /Enter a place/);
  await assert.rejects(lookup.search('a'.repeat(161)), /160 characters/);
  const result = await lookup.search('-28.28, 152.7');
  assert.equal(result.coordinates, true);
  assert.deepEqual(result.results[0].center, [152.7, -28.28]);
});

test('place lookup is an Australian hosted request and validates returned coordinates', async () => {
  const { createPlaceSearch } = await modulePromise;
  let request;
  const lookup = createPlaceSearch({ fetchImpl: async (url, options) => {
    request = { url: new URL(url), options };
    return response([feature('Mount Barney'), feature('Mount Barney'), feature('Bad point', [500, -28]), feature('No point', [null, null]), null, feature('West Peak', [152.68, -28.28])]);
  } });
  const result = await lookup.search('  Mount   Barney  ');
  assert.equal(request.url.origin, 'https://photon.komoot.io');
  assert.equal(request.url.searchParams.get('q'), 'Mount Barney');
  assert.equal(request.url.searchParams.get('countrycode'), 'AU');
  assert.equal(request.url.searchParams.get('limit'), '5');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(result.coordinates, false);
  assert.deepEqual(result.results.map(r => r.name), ['Mount Barney', 'West Peak']);
  assert.equal(result.results[0].context, 'Queensland, Australia');
});

test('recent repeated queries use only a bounded in-memory cache', async () => {
  const { createPlaceSearch } = await modulePromise;
  let requests = 0;
  const lookup = createPlaceSearch({ cacheLimit: 2, fetchImpl: async url => { requests++; return response([feature(new URL(url).searchParams.get('q'))]); } });
  const first = await lookup.search('Mount Barney');
  first.results[0].name = 'Changed by caller';
  const again = await lookup.search(' mount BARNEY ');
  assert.equal(requests, 1); assert.equal(again.results[0].name, 'Mount Barney');
  await lookup.search('Federation Peak'); await lookup.search('Mount Anne');
  await lookup.search('Mount Barney');
  assert.equal(requests, 4, 'the oldest cached query was evicted');
});

test('late place responses cannot overwrite a newer search or coordinate selection', async () => {
  const { createPlaceSearch } = await modulePromise;
  const pending = [];
  const lookup = createPlaceSearch({ fetchImpl: (_url, options) => new Promise(resolve => pending.push({ resolve, signal: options.signal })) });
  const first = lookup.search('Mount Barney');
  const second = lookup.search('Mount Anne');
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(response([feature('Mount Anne')]));
  assert.equal((await second).results[0].name, 'Mount Anne');
  pending[0].resolve(response([feature('Mount Barney')]));
  assert.equal(await first, null);
  const third = lookup.search('Cradle Mountain');
  await lookup.search('-28.28,152.7');
  pending[2].resolve(response([feature('Cradle Mountain')]));
  assert.equal(await third, null);
});

test('editing or dismissing a pending search cancels its eventual result', async () => {
  const { createPlaceSearch } = await modulePromise;
  let finish, signal;
  const lookup = createPlaceSearch({ fetchImpl: (_url, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  const pending = lookup.search('Mount Barney'); lookup.cancel();
  assert.equal(signal.aborted, true);
  finish(response([feature('Mount Barney')]));
  assert.equal(await pending, null);
});

test('place lookup distinguishes no results, service failures and timeout', async () => {
  const { createPlaceSearch } = await modulePromise;
  const empty = createPlaceSearch({ fetchImpl: async () => response([]) });
  assert.deepEqual((await empty.search('No such mountain')).results, []);
  const busy = createPlaceSearch({ fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(busy.search('Mount Barney'), /busy/);
  const offline = createPlaceSearch({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.search('Mount Barney'), /Check your connection/);
  const invalid = createPlaceSearch({ fetchImpl: async () => ({ ok: true, json: async () => ({ wrong: [] }) }) });
  await assert.rejects(invalid.search('Mount Barney'), /invalid response/);
  const slow = createPlaceSearch({ timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); }) });
  await assert.rejects(slow.search('Mount Barney'), /timed out/);
});
