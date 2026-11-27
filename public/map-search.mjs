const PHOTON_URL = 'https://photon.komoot.io/api/';
const COORDINATE_HELP = 'Use latitude, longitude (for example -28.28, 152.70), or include N/S and E/W.';

function checkedCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('Latitude must be between −90 and 90, and longitude between −180 and 180.');
  }
  return [lng, lat];
}

function degrees(text, hemisphere) {
  const parts = text.trim().replace(/[°º′’'″”":]/g, ' ').trim().split(/\s+/);
  if (!parts.length || parts.length > 3 || parts.some(p => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(p))) throw new Error(COORDINATE_HELP);
  const numbers = parts.map(Number), [d, m = 0, s = 0] = numbers;
  if (numbers.slice(1).some(v => v < 0 || v >= 60) || (parts.length > 1 && !Number.isInteger(d)) || (parts.length > 2 && !Number.isInteger(m))) throw new Error('Minutes and seconds must be below 60; only the last part may contain decimals.');
  const sign = /[SW]/.test(hemisphere) ? -1 : 1;
  if ((parts[0].startsWith('-') && sign > 0) || (parts[0].startsWith('+') && sign < 0)) throw new Error('The coordinate sign conflicts with its N/S/E/W direction.');
  return sign * (Math.abs(d) + m / 60 + s / 3600);
}

// Bare pairs are always latitude, longitude. Hemisphere letters also permit
// longitude first. Coordinate-like mistakes stay local instead of being searched.
export function parseCoordinates(input) {
  let text = input.trim().replace(/−/g, '-');
  if ((text.startsWith('(') && text.endsWith(')')) || (text.startsWith('[') && text.endsWith(']'))) text = text.slice(1, -1).trim();
  const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const pair = text.match(new RegExp(`^(${number})(?:\\s*[,;]\\s*|\\s+)(${number})$`));
  if (pair) return checkedCoordinates(Number(pair[1]), Number(pair[2]));
  const upper = text.toUpperCase();
  if (/\d/.test(upper) && /^[\d\s+.,;:°º′’'″”"\-NSEW]+$/.test(upper)) {
    const suffix = upper.match(/^([^NSEW]+)([NSEW])\s*[,;]?\s*([^NSEW]+)([NSEW])$/);
    const prefix = upper.match(/^([NSEW])([^NSEW]+?)\s*[,;]?\s*([NSEW])([^NSEW]+)$/);
    const parts = suffix ? [[suffix[1], suffix[2]], [suffix[3], suffix[4]]]
      : prefix ? [[prefix[2], prefix[1]], [prefix[4], prefix[3]]] : null;
    if (parts) {
      const latitude = parts.filter(([, h]) => /[NS]/.test(h)), longitude = parts.filter(([, h]) => /[EW]/.test(h));
      if (latitude.length !== 1 || longitude.length !== 1) throw new Error(COORDINATE_HELP);
      return checkedCoordinates(degrees(...latitude[0]), degrees(...longitude[0]));
    }
    // A lone integer can be a place name or postcode (for example Queensland's 1770).
    if (!/^\d+$/.test(text)) throw new Error(COORDINATE_HELP);
  }
  return null;
}

function places(data) {
  if (!Array.isArray(data?.features)) throw new Error('Place search returned an invalid response. Please try again.');
  const results = [], seen = new Set();
  for (const feature of data.features) {
    const p = feature?.properties, point = feature?.geometry?.coordinates;
    if (!p || feature.geometry?.type !== 'Point' || !Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite)) continue;
    try { checkedCoordinates(point[1], point[0]); } catch { continue; }
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || p.locality;
    if (typeof name !== 'string' || !name.trim()) continue;
    const context = [...new Set([p.city, p.county, p.state, p.country].filter(v => typeof v === 'string' && v && v !== name))].join(', ');
    const key = `${name}/${point[0]}/${point[1]}`;
    if (seen.has(key)) continue;
    seen.add(key); results.push({ name, context, center: point.slice(0, 2) });
    if (results.length === 5) break;
  }
  return results;
}

export function createPlaceSearch({ fetchImpl = fetch, endpoint = PHOTON_URL, cacheLimit = 32, timeoutMs = 10000 } = {}) {
  const cache = new Map();
  let revision = 0, active;
  function cancel() { revision++; active?.abort(); active = null; }
  async function search(input) {
    cancel();
    const current = revision, query = input.trim().replace(/\s+/g, ' ');
    if (!query) throw new Error('Enter a place name or coordinates.');
    if (query.length > 160) throw new Error('Keep the search under 160 characters.');
    const center = parseCoordinates(query);
    if (center) return { coordinates: true, results: [{ name: `${center[1].toFixed(5)}, ${center[0].toFixed(5)}`, context: 'Coordinates', center }] };
    const key = query.toLocaleLowerCase('en');
    if (cache.has(key)) return { coordinates: false, results: structuredClone(cache.get(key)) };
    const request = new AbortController(); active = request;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; request.abort(); }, timeoutMs);
    try {
      const url = new URL(endpoint);
      url.searchParams.set('q', query); url.searchParams.set('limit', '5');
      url.searchParams.set('lang', 'en'); url.searchParams.set('countrycode', 'AU');
      const response = await fetchImpl(url.href, { signal: request.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(response.status === 429 ? 'Place search is busy. Please wait a moment and try again.' : 'Place search is unavailable. Please try again.');
      const results = places(await response.json());
      if (current !== revision) return null;
      if (timedOut) throw new Error('Place search timed out. Please try again.');
      cache.set(key, results);
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      return { coordinates: false, results: structuredClone(results) };
    } catch (error) {
      if (current !== revision) return null;
      if (timedOut) throw new Error('Place search timed out. Please try again.');
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('Could not reach place search. Check your connection and try again.');
      throw error;
    } finally {
      clearTimeout(timer);
      if (active === request) active = null;
    }
  }
  return { search, cancel };
}

export function attachMapSearch({ map, Marker, document = globalThis.document, lookup = createPlaceSearch() }) {
  const form = document.getElementById('map-search'), input = document.getElementById('map-search-input');
  const list = document.getElementById('map-search-results'), message = document.getElementById('map-search-message');
  const clear = document.getElementById('map-search-clear');
  let marker, revision = 0;
  function reset() {
    revision++; lookup.cancel(); list.replaceChildren(); list.hidden = true;
    message.textContent = ''; message.hidden = true; message.classList.remove('error'); form.removeAttribute('aria-busy');
  }
  function say(text, error = false) { message.textContent = text; message.hidden = false; message.classList.toggle('error', error); }
  function choose(result) {
    marker?.remove(); marker = new Marker({ color: '#b34831' }).setLngLat(result.center).addTo(map);
    marker.getElement().setAttribute('aria-label', result.name);
    map.flyTo({ center: result.center, zoom: Math.max(map.getZoom(), 13) });
    list.hidden = true; clear.hidden = false;
    say(`Centred on ${result.name}${result.context && result.context !== 'Coordinates' ? ` · ${result.context}` : ''}.`);
  }
  input.addEventListener('input', reset);
  input.addEventListener('keydown', event => { if (event.key === 'Escape') { reset(); input.focus(); } });
  clear.addEventListener('click', () => { reset(); marker?.remove(); marker = null; clear.hidden = true; input.focus(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); reset(); const current = revision;
    form.setAttribute('aria-busy', 'true'); say('Searching…');
    try {
      const result = await lookup.search(input.value);
      if (current !== revision || !result) return;
      if (result.coordinates) { choose(result.results[0]); return; }
      if (!result.results.length) { say('No places found. Try a nearby town or paste coordinates.'); return; }
      for (const place of result.results) {
        const item = document.createElement('li'), button = document.createElement('button'); button.type = 'button';
        const name = document.createElement('strong'), context = document.createElement('span');
        name.textContent = place.name; context.textContent = place.context;
        button.append(name, context); button.addEventListener('click', () => choose(place)); item.append(button); list.append(item);
      }
      list.hidden = false; say(`${result.results.length} ${result.results.length === 1 ? 'place' : 'places'} found. Choose a result.`);
    } catch (error) { if (current === revision) say(error.message, true); }
    finally { if (current === revision) form.removeAttribute('aria-busy'); }
  });
}
