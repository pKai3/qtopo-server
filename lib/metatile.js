// MapLibre's zoom uses 512 logical pixels per XYZ tile. Output pixel density
// is applied separately, so a larger viewport never changes map detail.
const TILE_SIZE = 512;
function metatileLayout(tile, { metatileSize = 2, renderBufferPx = 64 } = {}) {
  const n = 2 ** tile.z, side = Math.min(metatileSize, n);
  const x = Math.floor(tile.x / side) * side, y = Math.floor(tile.y / side) * side;
  // Keep the viewport within the world at low zooms and the polar edges.
  // Otherwise MapLibre can constrain the camera and move the crop.
  const left = Math.min(renderBufferPx, x * TILE_SIZE);
  const top = Math.min(renderBufferPx, y * TILE_SIZE);
  const right = Math.min(renderBufferPx, (n - x - side) * TILE_SIZE);
  const bottom = Math.min(renderBufferPx, (n - y - side) * TILE_SIZE);
  const cx = x + side / 2 + (right - left) / (2 * TILE_SIZE);
  const cy = y + side / 2 + (bottom - top) / (2 * TILE_SIZE);
  return {
    z: tile.z, x, y, side, left, top,
    width: side * TILE_SIZE + left + right,
    height: side * TILE_SIZE + top + bottom,
    center: [cx / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * cy / n))) * 180 / Math.PI],
    mode: side > 1 || left || top || right || bottom ? 'static' : 'tile',
    tiles: Array.from({ length: side * side }, (_, i) => ({ z: tile.z, x: x + i % side, y: y + Math.floor(i / side) })),
  };
}
function copyTilePixels(pixels, layout, tile, size, destination) {
  const ratio = size / TILE_SIZE, width = layout.width * ratio;
  const left = (layout.left + (tile.x - layout.x) * TILE_SIZE) * ratio;
  const top = (layout.top + (tile.y - layout.y) * TILE_SIZE) * ratio;
  if (pixels.length !== width * layout.height * ratio * 4 || destination.length !== size * size * 4 ||
      ![width, left, top].every(Number.isInteger) || left < 0 || top < 0 || left + size > width || top + size > layout.height * ratio) {
    throw new Error('Unexpected metatile dimensions');
  }
  for (let row = 0; row < size; row++) {
    const offset = ((top + row) * width + left) * 4;
    destination.set(pixels.subarray(offset, offset + size * 4), row * size * 4);
  }
}
module.exports = { metatileLayout, copyTilePixels };
