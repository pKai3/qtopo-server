const fs = require('node:fs/promises');
const path = require('node:path');
const { httpError } = require('./utils');
function resolveIndex(index, tile) {
  let node = index, z = 0;
  while (true) {
    if (node === 0) return null;
    if (node === 1) return z;
    if (!Array.isArray(node) || node.length !== 4) throw httpError('Unsupported vector tile index');
    if (z === tile.z) return z;
    const bit = 2 ** (tile.z - z - 1);
    node = node[(Math.floor(tile.y / bit) % 2) * 2 + Math.floor(tile.x / bit) % 2];
    z++;
  }
}
function createTileIndex(config, cache) {
  const loaded = new Map();
  return async function nativeZoom(provider, tile) {
    let entry = loaded.get(provider.tileMap);
    if (!entry || Date.now() >= entry.expires) {
      entry = { expires: config.resourceTTL ? Date.now() + config.resourceTTL : Infinity };
      entry.promise = cache.get({
        file: path.join(config.resourceDir, 'v2', provider.id, provider.cacheId, 'tilemap.json'),
        url: provider.tileMap, ttl: config.resourceTTL, kind: 'json', allowEmpty: false,
      }).then(async result => JSON.parse(await fs.readFile(result.path, 'utf8')).index).catch(err => {
        if (loaded.get(provider.tileMap) === entry) loaded.delete(provider.tileMap);
        throw err;
      });
      loaded.set(provider.tileMap, entry);
    }
    return resolveIndex(await entry.promise, tile);
  };
}
module.exports = { createTileIndex, resolveIndex };
