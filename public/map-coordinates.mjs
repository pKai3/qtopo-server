export function attachMapCoordinates({ map, element }) {
  let pointer;
  const update = () => {
    const position = pointer ? map.unproject(pointer) : map.getCenter();
    element.textContent = `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)} · zoom ${map.getZoom().toFixed(1)}`;
  };
  const movedPointer = event => {
    pointer = { x: event.point.x, y: event.point.y };
    update();
  };
  map.on('mousemove', movedPointer);
  // Camera movement includes button/scroll/touch zooms and panning. Reproject
  // the stationary pointer so its coordinate does not refer to the old camera.
  map.on('move', update);
  map.on('resize', update);
  update();
  return () => {
    map.off('mousemove', movedPointer);
    map.off('move', update);
    map.off('resize', update);
  };
}
