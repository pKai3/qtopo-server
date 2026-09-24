import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
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
    catalog.providers.unshift({ ...catalog.automatic, id: 'auto', name: 'QLD + NSW — automatic', type: 'raster', center: initial.center, zoom: initial.zoom });
    let provider = catalog.providers.find(p => p.id === params.get('provider')) || catalog.providers[0];
    for (const p of catalog.providers) $('provider').add(new Option(p.name, p.id));
    $('provider').value = provider.id;
    $('mode').value = params.get('mode') === 'raster' ? 'raster' : 'vector';
    function previewStyle() {
      if ($('mode').value !== 'raster' && provider.type !== 'raster') return provider.style;
      return {
        version: 8, glyphs: location.origin + '/fonts/{fontstack}/{range}.pbf',
        sources: { topo: { type: 'raster', tiles: [provider.raster], tileSize: provider.id === 'nsw-topo' ? 256 : 512, bounds: provider.bounds, maxzoom: provider.maxzoom, attribution: provider.attribution } },
        layers: [{ id: 'topographic-map', type: 'raster', source: 'topo' }],
      };
    }
    const map = new maplibregl.Map({ container: 'map', style: previewStyle(), center: provider.center, zoom: provider.zoom, hash: true, maxZoom: 22 });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
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
      const raster = $('mode').value === 'raster' || provider.type === 'raster';
      $('mode').disabled = provider.type === 'raster';
      $('layers').disabled = raster;
      $('layers').style.opacity = raster ? '0.45' : '1';
      $('tile-size').textContent = `${provider.tileSize} × ${provider.tileSize} raster tiles · ${provider.attribution}`;
      $('status').textContent = ''; $('status').className = '';
      params.set('provider', provider.id); params.set('mode', $('mode').value);
      history.replaceState(null, '', '?' + params.toString() + location.hash);
    }
    async function showRegions() {
      if (!map.isStyleLoaded()) return;
      if ($('regions').checked && !map.getSource('regions')) {
        map.addSource('regions', { type: 'geojson', data: '/regions.geojson' });
        map.addLayer({ id: 'regions-outline', type: 'line', source: 'regions', paint: { 'line-color': '#aa4938', 'line-width': 2 } });
        map.addLayer({ id: 'regions-label', type: 'symbol', source: 'regions', layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-font': provider.id === 'nsw' && $('mode').value !== 'raster' ? ['Public Sans Regular'] : ['Open Sans Regular', 'Arial Unicode MS Regular'] }, paint: { 'text-color': '#aa4938', 'text-halo-color': '#ffffff', 'text-halo-width': 1 } });
      }
      for (const id of ['regions-outline', 'regions-label']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', $('regions').checked ? 'visible' : 'none');
    }
    function switchStyle() {
      syncUI();
      map.setStyle(previewStyle());
    }
    map.on('style.load', () => { applyLayers(); showRegions(); });
    map.on('error', e => { console.error(e.error); $('status').textContent = 'Some map data could not load. Please try again shortly.'; $('status').className = 'error'; });
    map.on('mousemove', e => { $('coordinates').textContent = `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)} · zoom ${map.getZoom().toFixed(1)}`; });
    $('provider').addEventListener('change', () => {
      provider = catalog.providers.find(p => p.id === $('provider').value); switchStyle();
      const c = map.getCenter(), b = provider.bounds;
      if (c.lng < b[0] || c.lng > b[2] || c.lat < b[1] || c.lat > b[3]) map.flyTo({ center: provider.center, zoom: provider.zoom });
    });
    $('mode').addEventListener('change', switchStyle);
    $('regions').addEventListener('change', showRegions);
    $('copy-url').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(catalog.automatic.raster); $('status').textContent = 'QLD + NSW tile URL copied.'; }
      catch { window.prompt('Copy this QLD + NSW URL into Gaia or your GPS app:', catalog.automatic.raster); }
    });
    syncUI();
    if (innerWidth < 600) document.querySelector('details').open = false;
  } catch (err) { $('status').textContent = err.message; $('status').className = 'error'; }
})();
