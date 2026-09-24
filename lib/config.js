const path = require('node:path');
function text(v, fallback) { return v == null || v === '' ? fallback : v.trim().replace(/^(['"])(.*)\1$/, '$2'); }
function number(env, name, fallback, min, max, integer = false) {
  const v = Number(text(env[name], String(fallback)));
  if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  return v;
}
function loadConfig(env = process.env) {
  const root = path.resolve(__dirname, '..');
  const dataDir = path.resolve(text(env.DATA_DIR, '/data'));
  const styleDir = path.resolve(text(env.STYLE_DIR, path.join(dataDir, 'styles')));
  const tilePx = number(env, 'TILE_PX', 1024, 256, 1024, true);
  if (![256, 512, 1024].includes(tilePx)) throw new Error('TILE_PX must be 256, 512 or 1024');
  const publicUrl = text(env.PUBLIC_URL, '').replace(/\/$/, '');
  if (publicUrl && !/^https?:\/\/[^/]+(?:\/[^?#]*)?$/.test(publicUrl)) throw new Error('PUBLIC_URL must be an HTTP(S) URL');
  const renderConcurrency = number(env, 'RENDER_CONCURRENCY', 2, 1, 16, true);
  return {
    root, dataDir, styleDir, publicUrl,
    stylePath: path.resolve(text(env.STYLE_PATH, path.join(styleDir, 'style.json'))),
    vectorDir: path.resolve(text(env.VECTOR_DIR, path.join(dataDir, 'vector'))),
    rasterDir: path.resolve(text(env.RASTER_DIR, path.join(dataDir, 'raster'))),
    resourceDir: path.join(dataDir, 'resources'),
    fontDir: path.resolve(text(env.FONT_DIR, path.join(root, 'assets/fonts'))),
    port: number(env, 'PORT', 8080, 0, 65535, true),
    tilePx, labelScale: number(env, 'LABEL_SCALE', 1, 0.5, 3),
    pngCompression: number(env, 'PNG_COMPRESSION_LEVEL', 3, 0, 9, true),
    renderConcurrency,
    renderQueueLimit: number(env, 'RENDER_QUEUE_LIMIT', 64, 1, 1000, true),
    prefetchRadius: number(env, 'PREFETCH_RADIUS', 1, 0, 2, true),
    prefetchZoom: number(env, 'PREFETCH_ZOOM', 1, 0, 1, true) === 1,
    prefetchConcurrency: Math.min(number(env, 'PREFETCH_CONCURRENCY', Math.max(1, renderConcurrency - 1), 1, 16, true), Math.max(1, renderConcurrency - 1)),
    prefetchQueueLimit: number(env, 'PREFETCH_QUEUE_LIMIT', 64, 1, 1000, true),
    renderTimeoutMs: number(env, 'RENDER_TIMEOUT_SECONDS', 60, 1, 300) * 1000,
    upstreamTimeoutMs: number(env, 'UPSTREAM_TIMEOUT_SECONDS', 20, 1, 120) * 1000,
    upstreamConcurrency: number(env, 'UPSTREAM_CONCURRENCY', 16, 1, 64, true),
    vectorTTL: number(env, 'VECTOR_TTL_HOURS', 168, 0, 87600) * 3600000,
    rasterTTL: number(env, 'RASTER_TTL_HOURS', 72, 0, 87600) * 3600000,
    resourceTTL: number(env, 'RESOURCE_TTL_HOURS', 168, 0, 87600) * 3600000,
    emptyTTL: number(env, 'EMPTY_TILE_TTL_MINUTES', 30, 1, 1440) * 60000,
    cleanupInterval: env.CLEANUP_INTERVAL_MINUTES != null
      ? number(env, 'CLEANUP_INTERVAL_MINUTES', 15, 0, 10080) * 60000
      : number(env, 'CLEANER_INTERVAL_HOURS', 0.25, 0, 168) * 3600000,
    clearRaster: text(env.CLEAR_RASTER_ON_BOOT, '') === '1',
    defaultProvider: text(env.DEFAULT_PROVIDER, 'qld'),
    qldUpstream: text(env.VECTOR_UPSTREAM, ''),
  };
}
module.exports = { loadConfig };
