const path = require('node:path');
const { getProfile } = require('./profiles');
const { validProfileId } = require('./profile-files');
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
  const renderConcurrency = number(env, 'RENDER_CONCURRENCY', 8, 1, 24, true);
  const renderBufferPx = number(env, 'RENDER_BUFFER_PX', 64, 0, 256, true);
  if (renderBufferPx % 2) throw new Error('RENDER_BUFFER_PX must be an even number');
  const defaultProfile = text(env.DEFAULT_PROFILE, 'readable');
  if (!getProfile(defaultProfile) && !validProfileId(defaultProfile)) throw new Error(`Unknown DEFAULT_PROFILE: ${defaultProfile}`);
  return {
    root, dataDir, styleDir, publicUrl, defaultProfile,
    profileDir: path.resolve(text(env.PROFILE_DIR, styleDir)),
    stylePath: path.resolve(text(env.STYLE_PATH, path.join(styleDir, 'style.json'))),
    vectorDir: path.resolve(text(env.VECTOR_DIR, path.join(dataDir, 'vector'))),
    rasterDir: path.resolve(text(env.RASTER_DIR, path.join(dataDir, 'raster'))),
    resourceDir: path.join(dataDir, 'resources'),
    fontDir: path.resolve(text(env.FONT_DIR, path.join(root, 'assets/fonts'))),
    port: number(env, 'PORT', 8080, 0, 65535, true),
    adminAllowedNetworks: text(env.ADMIN_ALLOWED_NETWORKS, ''),
    adminAllowedHosts: text(env.ADMIN_ALLOWED_HOSTS, 'localhost,127.0.0.1,[::1]'),
    trustedProxies: text(env.TRUSTED_PROXIES, ''),
    tilePx, labelScale: number(env, 'LABEL_SCALE', 1, 0.5, 3),
    metatileSize: number(env, 'METATILE_SIZE', 2, 1, 2, true), renderBufferPx,
    pngCompression: number(env, 'PNG_COMPRESSION_LEVEL', 3, 0, 9, true),
    renderConcurrency,
    renderMemoryGuard: number(env, 'RENDER_MEMORY_GUARD', 1, 0, 1, true) === 1,
    renderMemoryHeadroomMb: number(env, 'RENDER_MEMORY_HEADROOM_MB', 512, 0, 65536, true),
    renderMemoryHeadroomPercent: number(env, 'RENDER_MEMORY_HEADROOM_PERCENT', 12.5, 0, 50),
    renderMemoryInitialWorkerMb: number(env, 'RENDER_MEMORY_INITIAL_WORKER_MB', 512, 128, 4096, true),
    renderWorkerMaxRssMb: number(env, 'RENDER_WORKER_MAX_RSS_MB', 384, 64, 4096, true),
    requestReprioritize: number(env, 'REQUEST_REPRIORITIZE', 1, 0, 1, true) === 1,
    requestPanThreshold: number(env, 'REQUEST_PAN_THRESHOLD', 8, 1, Number.MAX_SAFE_INTEGER, true),
    renderQueueLimit: number(env, 'RENDER_QUEUE_LIMIT', 64, 1, 1000, true),
    prefetchRadius: number(env, 'PREFETCH_RADIUS', 1, 0, 10, true),
    prefetchZoom: number(env, 'PREFETCH_ZOOM', 1, 0, 1, true) === 1,
    prefetchPreempt: number(env, 'PREFETCH_PREEMPT', 1, 0, 1, true) === 1,
    prefetchConcurrency: Math.min(number(env, 'PREFETCH_CONCURRENCY', Math.max(1, renderConcurrency - 1), 1, 24, true), Math.max(1, renderConcurrency - 1)),
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
