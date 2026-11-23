const { Canvas } = require('canvas');

function encodePng(canvas, compression = 3, vector = false) {
  // Flat map colours compress well without PNG's per-row adaptive filter search.
  // Keep the existing adaptive filters for scanned imagery and composites.
  return canvas.toBuffer('image/png', {
    compressionLevel: compression,
    filters: vector ? Canvas.PNG_FILTER_NONE : Canvas.PNG_ALL_FILTERS,
  });
}

module.exports = { encodePng };
