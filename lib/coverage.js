const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./providers');
const boundaryText = fs.readFileSync(path.join(__dirname, '../assets/nsw-coverage.geojson'), 'utf8');
const boundaryRevision = hash(boundaryText);
function project([lng, lat]) {
  return [(lng + 180) / 360, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2];
}
// Follow the shared land border, extending across rivers and coastal water.
// A land-only state polygon would cut water features out of the rendered map.
const rings = JSON.parse(boundaryText).features.flatMap(f => {
  const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return polygons.map(p => p[0].map(project));
}).map(points => ({ points, bounds: points.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [1, 1, 0, 0]) }));
function contains(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segmentIntersects([ax, ay], [bx, by], [left, top, right, bottom]) {
  let start = 0, end = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - left], [dx, right - ax], [-dy, ay - top], [dy, bottom - ay]]) {
    if (p === 0) { if (q < 0) return false; }
    else if (p < 0) start = Math.max(start, q / p);
    else end = Math.min(end, q / p);
    if (start > end) return false;
  }
  return true;
}
function coverage({ z, x, y }) {
  const n = 2 ** z, box = [x / n, y / n, (x + 1) / n, (y + 1) / n];
  const relevant = rings.filter(({ bounds: b }) => b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1]);
  let intersects = false, inside = false;
  for (const { points } of relevant) {
    inside ||= contains(points, (x + 0.5) / n, (y + 0.5) / n);
    for (let i = 1; i < points.length && !intersects; i++) intersects = segmentIntersects(points[i - 1], points[i], box);
  }
  return { region: intersects ? 'border' : inside ? 'nsw' : 'qld', rings: intersects ? relevant.map(({ points }) => points.map(([px, py]) => [px * n - x, py * n - y])) : [] };
}
module.exports = { coverage, boundaryRevision };
