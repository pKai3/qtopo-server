function project([lng, lat]) {
  return [(lng + 180) / 360, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2];
}
function contains(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function createStateSelector(coverage) {
  const polygons = coverage.features.flatMap(({ geometry }) => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates)
    .map(polygon => polygon.map(ring => ring.map(project)));
  return ({ lng, lat }) => {
    const [x, y] = project([((lng + 180) % 360 + 360) % 360 - 180, lat]);
    return polygons.some(([outer, ...holes]) => contains(outer, x, y) && !holes.some(hole => contains(hole, x, y))) ? 'nsw' : 'qld';
  };
}
export function selectPreview(provider, mode, providers, center, selectState) {
  const selected = provider.id === 'auto' && mode === 'vector'
    ? providers.find(p => p.id === selectState(center)) : provider;
  return { provider: selected, mode: selected.type === 'raster' ? 'raster' : mode };
}
