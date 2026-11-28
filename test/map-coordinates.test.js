const { test } = require('node:test');
const assert = require('node:assert/strict');

function fixture() {
  const listeners = new Map();
  return {
    element: { textContent: '' }, zoom: 11, center: { lat: -33.72, lng: 150.31 }, ground: { lat: -33.73, lng: 150.32 },
    getCenter() { return this.center; }, getZoom() { return this.zoom; },
    unproject(point) { this.projectedPoint = { ...point }; return this.ground; },
    on(event, fn) { listeners.set(event, fn); }, off(event) { listeners.delete(event); },
    fire(event, data) { listeners.get(event)?.(data); },
  };
}

test('coordinate readout updates at the map centre during button or touch camera movement before a pointer arrives', async () => {
  const { attachMapCoordinates } = await import('../public/map-coordinates.mjs');
  const map = fixture();
  attachMapCoordinates({ map, element: map.element });
  assert.equal(map.element.textContent, '-33.72000, 150.31000 · zoom 11.0');
  map.zoom = 12.5; map.center = { lat: -34, lng: 151 };
  map.fire('move');
  assert.equal(map.element.textContent, '-34.00000, 151.00000 · zoom 12.5');
  assert.equal(map.projectedPoint, undefined);
});

test('a stationary pointer is reprojected when the map zooms, pans or resizes', async () => {
  const { attachMapCoordinates } = await import('../public/map-coordinates.mjs');
  const map = fixture(), stop = attachMapCoordinates({ map, element: map.element });
  const point = { x: 100, y: 200 };
  map.fire('mousemove', { point });
  assert.equal(map.element.textContent, '-33.73000, 150.32000 · zoom 11.0');
  point.x = 0;
  map.zoom = 18; map.ground = { lat: -33.725, lng: 150.315 };
  map.fire('move');
  assert.deepEqual(map.projectedPoint, { x: 100, y: 200 });
  assert.equal(map.element.textContent, '-33.72500, 150.31500 · zoom 18.0');
  map.ground = { lat: -33.726, lng: 150.316 };
  map.fire('resize');
  assert.equal(map.element.textContent, '-33.72600, 150.31600 · zoom 18.0');
  stop(); map.zoom = 10; map.fire('move');
  assert.equal(map.element.textContent, '-33.72600, 150.31600 · zoom 18.0');
});
