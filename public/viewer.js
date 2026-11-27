import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
import { createStateSelector, selectPreview } from './preview.mjs';
import { attachMapSearch } from './map-search.mjs';
import { attachContourStatus, addAvailableProfiles } from './contour-status.mjs';
import { attachMapCoordinates } from './map-coordinates.mjs';
(async () => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const groups = {
    Contours: /contour/i, Roads: /road|busway/i, Trails: /trail|path|aggregatedway/i,
    Reserves: /national.park|state.forest|nature.refuge|conservation|NPWSReserve/i,
    Places: /mountain|placepoint|populated.place|spotheight/i,
  };
  try {
    const response = await fetch('/api/providers');
    if (!response.ok) throw new Error('Could not load the map list.');
    const catalog = await response.json();
    const initial = catalog.providers.find(p => p.id === catalog.defaultProvider);
    catalog.providers.unshift({ ...catalog.automatic, id: 'auto', name: 'QLD + NSW — automatic', type: 'vector', center: initial.center, zoom: initial.zoom });
    let provider = catalog.providers.find(p => p.id === params.get('provider')) || catalog.providers[0];
    const findProfile = id => catalog.profiles.find(p => p.id === id || p.aliases?.includes(id));
    let profile = findProfile(location.pathname.replace(/\/$/, '') === '/classic' ? 'classic' : params.get('profile')) || findProfile(catalog.defaultProfile);
    for (const p of catalog.profiles.filter(p => !p.hidden || p === profile)) $('profile').add(new Option(p.name, p.id));
    $('profile').value = profile.id;
    let selection, currentStyle, revision = 0, stateSelector;
    for (const p of catalog.providers) $('provider').add(new Option(p.name, p.id));
    $('provider').value = provider.id;
    $('mode').value = params.get('mode') === 'raster' ? 'raster' : 'vector';
    $('mode-label').textContent = $('mode').value === 'raster' ? 'Raster' : 'Vector';
    function previewStyle({ provider: selected, mode }) {
      if (mode === 'vector') return `/styles/${profile.id}/${selected.id}.json`;
      const rasterURL = selected.id === 'auto' ? profile.raster : `${location.origin}/raster/${profile.id}/${selected.id}/{z}/{x}/{y}.png`;
      return {
        version: 8, glyphs: location.origin + '/fonts/{fontstack}/{range}.pbf',
        sources: { topo: { type: 'raster', tiles: [rasterURL], tileSize: selected.id === 'nsw-topo' ? 256 : 512, bounds: selected.bounds, maxzoom: selected.maxzoom, attribution: selected.attribution } },
        layers: [{ id: 'topographic-map', type: 'raster', source: 'topo' }],
      };
    }
    // Resolve the actual camera after MapLibre restores the shared URL hash.
    // Start empty so automatic vector mode never briefly requests PNG tiles.
    const map = new maplibregl.Map({ container: 'map', style: { version: 8, sources: {}, layers: [] }, center: provider.center, zoom: provider.zoom, hash: true, maxZoom: catalog.automatic.maxzoom });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
    attachMapSearch({ map, Marker: maplibregl.Marker });
    const visibility = Object.fromEntries(Object.keys(groups).map(k => [k, true]));
    for (const name of Object.keys(groups)) {
      const label = document.createElement('label'); label.className = 'check';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true;
      input.addEventListener('change', () => { visibility[name] = input.checked; applyLayers(); });
      label.append(input, name); $('layers').append(label);
    }
    function applyLayers() {
      for (const layer of map.getStyle()?.layers || []) {
        const names = [layer.id, layer['source-layer'] || ''].join(' ');
        const group = Object.keys(groups).find(k => groups[k].test(names));
        if (group && map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility', visibility[group] ? 'visible' : 'none');
      }
    }
    function syncUI() {
      const raster = selection.mode === 'raster', selected = selection.provider;
      $('mode').value = selection.mode;
      $('mode-label').textContent = raster ? 'Raster' : 'Vector';
      $('mode').disabled = provider.type === 'raster';
      $('profile').disabled = provider.type === 'raster';
      $('layers').disabled = raster;
      $('layers').style.opacity = raster ? '0.45' : '1';
      $('tile-size').textContent = raster ? `${selected.tileSize} × ${selected.tileSize} raster tiles · ${selected.attribution}`
        : `Interactive vectors · ${selected.name}${provider.id === 'auto' ? ' · selected by map centre' : ''} · ${selected.attribution}`;
      $('status').textContent = ''; $('status').className = '';
      params.set('profile', profile.id); params.set('provider', provider.id); params.set('mode', $('mode').value);
      history.replaceState(null, '', (profile.id === 'classic' ? '/classic' : '/') + '?' + params.toString() + location.hash);
    }
    async function showRegions() {
      if (!selection || !map.isStyleLoaded()) return;
      if ($('regions').checked && !map.getSource('regions')) {
        map.addSource('regions', { type: 'geojson', data: '/regions.geojson' });
        map.addLayer({ id: 'regions-outline', type: 'line', source: 'regions', paint: { 'line-color': '#aa4938', 'line-width': 2 } });
        map.addLayer({ id: 'regions-label', type: 'symbol', source: 'regions', layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-font': selection.provider.id === 'nsw' && selection.mode === 'vector' ? ['Public Sans Regular'] : ['Open Sans Regular', 'Arial Unicode MS Regular'] }, paint: { 'text-color': '#aa4938', 'text-halo-color': '#ffffff', 'text-halo-width': 1 } });
      }
      for (const id of ['regions-outline', 'regions-label']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', $('regions').checked ? 'visible' : 'none');
    }
    async function switchStyle() {
      const request = ++revision, selected = provider, mode = $('mode').value, center = map.getCenter();
      try {
        let selectState;
        if (selected.id === 'auto' && mode === 'vector') {
          stateSelector ||= fetch('/assets/nsw-coverage.geojson').then(async response => {
            if (!response.ok) throw new Error('Could not load the state boundary.');
            return createStateSelector(await response.json());
          }).catch(error => { stateSelector = null; throw error; });
          selectState = await stateSelector;
        }
        if (request !== revision) return;
        selection = selectPreview(selected, mode, catalog.providers, center, selectState);
        const key = `${selection.provider.id}/${selection.mode}/${profile.id}`;
        if (key === currentStyle) { syncUI(); return; }
        syncUI();
        // Keep the camera and layer preferences when the selected state changes.
        map.setStyle(previewStyle(selection));
        currentStyle = key;
      } catch (error) {
        if (request !== revision) return;
        $('status').textContent = error.message; $('status').className = 'error';
      }
    }
    map.on('style.load', () => { applyLayers(); showRegions(); });
    map.on('error', e => { console.error(e.error); $('status').textContent = 'Some map data could not load. Please try again shortly.'; $('status').className = 'error'; });
    attachMapCoordinates({ map, element: $('coordinates') });
    map.on('moveend', () => { if (provider.id === 'auto' && $('mode').value === 'vector') switchStyle(); });
    $('provider').addEventListener('change', () => {
      provider = catalog.providers.find(p => p.id === $('provider').value); switchStyle();
      const c = map.getCenter(), b = provider.bounds;
      if (c.lng < b[0] || c.lng > b[2] || c.lat < b[1] || c.lat > b[3]) map.flyTo({ center: provider.center, zoom: provider.zoom });
    });
    $('mode').addEventListener('change', switchStyle);
    $('profile').addEventListener('change', () => { profile = catalog.profiles.find(p => p.id === $('profile').value); switchStyle(); });
    $('regions').addEventListener('change', showRegions);
    $('copy-url').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(profile.raster); $('status').textContent = `${profile.name} QLD + NSW tile URL copied.`; }
      catch { window.prompt('Copy this QLD + NSW URL into Gaia or your GPS app:', profile.raster); }
    });
    await switchStyle();
    if (innerWidth < 600) $('map-controls').open = false;
    attachContourStatus({ element: $('contour-status'), panel: $('map-controls'),
      available: catalog.profiles.some(p => p.id === 'nsw-2m'),
      onProfiles: available => { catalog.profiles = addAvailableProfiles($('profile'), catalog.profiles, available); },
    });
  } catch (err) { $('status').textContent = err.message; $('status').className = 'error'; }
})();
