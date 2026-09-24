#!/usr/bin/env node
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const L = require('./lib/logger');
const { loadConfig } = require('./lib/config');
const { createProviders, tileURL, parseTile, hash } = require('./lib/providers');
const { createCache } = require('./lib/cache');
const { cachedRaster, httpError } = require('./lib/utils');
const { seedStyles, createStyleCache, absoluteStyle, renderStyle } = require('./lib/styles');
const { createRenderer } = require('./lib/render');
const { startCleaner } = require('./lib/cleaner');
const { coverage, boundaryRevision } = require('./lib/coverage');
const { createTileIndex } = require('./lib/tile-index');
const { createPrefetch } = require('./lib/prefetch');
const { PRIORITY } = require('./lib/queue');
const { createRequestMetrics } = require('./lib/metrics');

async function createApp(config = loadConfig(), dependencies = {}) {
  process.umask(0o002);
  const providers = dependencies.providers || createProviders(config);
  await seedStyles(config, providers);
  const styles = createStyleCache(config), requests = createRequestMetrics();
  const startedAt = new Date().toISOString();
  for (const dir of [config.vectorDir, config.rasterDir, config.resourceDir]) await fs.mkdir(path.join(dir, 'v2'), { recursive: true });
  if (config.clearRaster) await fs.rm(path.join(config.rasterDir, 'v2'), { recursive: true, force: true });
  const cache = dependencies.cache || createCache({ timeoutMs: config.upstreamTimeoutMs, emptyTTL: config.emptyTTL, concurrency: config.upstreamConcurrency, logger: L });
  const renderer = dependencies.renderer || createRenderer(config);
  const nativeZoom = dependencies.nativeZoom || createTileIndex(config, cache);
  const stopCleaner = startCleaner(config, L);
  const app = express();
  const prefetch = createPrefetch({
    radius: config.prefetchRadius, zoom: config.prefetchZoom, concurrency: config.prefetchConcurrency,
    limit: config.prefetchQueueLimit, logger: L,
    zoomRange: id => id === 'auto' ? { minzoom: 0, maxzoom: providers.qld.maxzoom } : providers[id],
    render: async (id, tile, priority, rank) => {
      const result = await (id === 'auto' ? automaticRasterFile(tile, priority, rank) : rasterFile(providers[id], tile, priority, rank));
      requests.prefetched(result);
    },
  });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (/^\/(raster|vector|tiles_raster|tiles_vector)\//.test(req.path)) {
      const started = Date.now();
      L.log('REQ', `${req.method} ${req.path}`);
      res.once('finish', () => L.log('RES', `${res.statusCode} ${req.path} (${Date.now() - started} ms)`));
      res.once('close', () => {
        if (!res.writableFinished) L.warn('RES', `Disconnected: ${req.path} (${Date.now() - started} ms)`);
      });
    }
    next();
  });
  const origin = req => config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const resourcePriority = req => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const priority = Number(req.get('X-QTopo-Priority'));
    return local && [PRIORITY.NEIGHBOUR, PRIORITY.ZOOM].includes(priority) ? priority : PRIORITY.REQUEST;
  };
  function providerFor(req, type) {
    const id = req.params.provider || 'qld';
    const p = Object.hasOwn(providers, id) ? providers[id] : null;
    if (!p || (type && p.type !== type)) throw httpError('Unknown map provider', 404);
    return p;
  }
  function coordinates(req, p) {
    const tile = parseTile(req.params, p.maxzoom);
    if (!tile) throw httpError('Invalid tile coordinates or zoom', 400);
    return tile;
  }
  function headers(res, seconds = 3600) { res.set('Cache-Control', `public, max-age=${seconds}`); }
  function sendFile(res, file, type) {
    res.type(type);
    return new Promise((resolve, reject) => res.sendFile(file, err => err ? reject(err) : resolve()));
  }
  async function vector(req, res) {
    const p = providerFor(req, 'vector');
    const { z, x, y } = coordinates(req, p);
    const result = await cache.get({
      file: path.join(config.vectorDir, 'v2', p.id, p.cacheId, String(z), String(x), `${y}.pbf`),
      url: tileURL(p, z, x, y), ttl: config.vectorTTL, logTag: 'PBF', priority: resourcePriority(req),
    });
    headers(res, result.empty ? Math.floor(config.emptyTTL / 1000) : 3600);
    if (result.empty) return res.status(204).end();
    await sendFile(res, result.path, 'application/x-protobuf');
  }
  async function styleForRaster(p, tile) {
    const prepared = await styles.get(p);
    return p.tileMap ? prepared.atZoom(await nativeZoom(p, tile)) : prepared;
  }
  const renderTag = priority => ['RDR', 'PREFETCH', 'PREFETCH-Z'][priority];
  async function rasterFile(p, tile, priority = PRIORITY.REQUEST, rank = 0) {
    const { style, revision } = await styleForRaster(p, tile);
    const outPath = path.join(config.rasterDir, 'v2', p.id, revision, String(tile.z), String(tile.x), `${tile.y}.png`);
    let cached = await cachedRaster(outPath, config.rasterTTL, config.emptyTTL);
    const hit = !!cached;
    if (!cached) {
      L.log(renderTag(priority), `Generating tile: ${outPath}`);
      const job = { ...tile, outPath, priority, rank, styleKey: revision, size: p.type === 'raster' ? 256 : config.tilePx };
      if (p.type === 'raster') {
        const image = await cache.get({
          file: path.join(config.resourceDir, 'v2', p.id, p.cacheId, String(tile.z), String(tile.x), `${tile.y}.image`),
          url: tileURL(p, tile.z, tile.x, tile.y), ttl: config.rasterTTL, kind: 'image', logTag: 'IMG', priority,
        });
        Object.assign(job, { kind: 'image', inputPath: image.empty ? null : image.path });
      } else {
        const internalOrigin = app.locals.internalOrigin;
        if (!internalOrigin) throw httpError('Renderer not ready', 503);
        Object.assign(job, { kind: 'vector', origin: internalOrigin, style: absoluteStyle(renderStyle(style, config.labelScale, p.id === 'qld'), internalOrigin) });
      }
      await renderer.render(job);
      cached = await cachedRaster(outPath, config.rasterTTL, config.emptyTTL);
    } else if (priority === PRIORITY.REQUEST) L.log('RDR', `Cached tile: ${outPath}`);
    if (!cached) throw httpError('Rendered tile is unavailable');
    return { path: outPath, empty: cached.empty, hit };
  }
  async function deliverRaster(res, result) {
    if (result.empty) L.log('RDR', `Empty tile: ${result.path}`);
    headers(res, result.empty ? Math.floor(config.emptyTTL / 1000) : 3600);
    await sendFile(res, result.path, 'image/png');
  }
  async function raster(req, res) {
    const p = providerFor(req);
    await serveRaster(req, res, p);
  }
  async function automaticRaster(req, res) {
    await serveRaster(req, res);
  }
  async function serveRaster(req, res, p) {
    const tile = coordinates(req, p || providers.qld);
    const measured = requests.begin();
    res.once('finish', () => measured.finish(res.statusCode, false, res.statusCode === 304 ? 0 : res.getHeader('content-length')));
    res.once('close', () => { if (!res.writableFinished) measured.finish(res.statusCode, true); });
    const finish = prefetch.begin(p?.id || 'auto', tile);
    let success = false;
    try {
      const result = await (p ? rasterFile(p, tile) : automaticRasterFile(tile));
      measured.ready(result);
      await deliverRaster(res, result);
      success = true;
    } finally { finish(success); }
  }
  async function automaticRasterFile(tile, priority = PRIORITY.REQUEST, rank = 0) {
    const area = coverage(tile);
    if (priority === PRIORITY.REQUEST) L.log('AUTO', `${tile.z}/${tile.x}/${tile.y}: ${area.region === 'border' ? 'QLD + NSW border' : area.region.toUpperCase()} vectors`);
    if (area.region === 'qld') return rasterFile(providers.qld, tile, priority, rank);
    if (area.region === 'nsw') return rasterFile(providers.nsw, tile, priority, rank);
    const [qldStyle, nswStyle] = await Promise.all([styleForRaster(providers.qld, tile), styleForRaster(providers.nsw, tile)]);
    const revision = hash(JSON.stringify({ version: 2, boundaryRevision, qld: qldStyle.revision, nsw: nswStyle.revision }));
    const outPath = path.join(config.rasterDir, 'v2', 'auto', revision, String(tile.z), String(tile.x), `${tile.y}.png`);
    let cached = await cachedRaster(outPath, config.rasterTTL, config.emptyTTL);
    const hit = !!cached;
    if (!cached) {
      L.log(renderTag(priority), `Generating border tile: ${outPath}`);
      const [backgroundPath, foregroundPath] = await Promise.all([rasterFile(providers.qld, tile, priority, rank), rasterFile(providers.nsw, tile, priority, rank)]);
      const rect = [0, 0, config.tilePx, config.tilePx];
      await renderer.render({ ...tile, outPath, priority, rank, size: config.tilePx, kind: 'composite', backgroundPath: backgroundPath.path, images: [{ path: foregroundPath.path, source: rect, destination: rect }], clip: area.rings });
      cached = await cachedRaster(outPath, config.rasterTTL, config.emptyTTL);
    } else if (priority === PRIORITY.REQUEST) L.log('RDR', `Cached border tile: ${outPath}`);
    if (!cached) throw httpError('Rendered border tile is unavailable');
    return { path: outPath, empty: cached.empty, hit };
  }

  app.get('/api/providers', (req, res) => {
    res.set('Cache-Control', 'no-cache').json({
      defaultProvider: config.defaultProvider,
      automatic: { raster: `${origin(req)}/raster/{z}/{x}/{y}.png`, tileSize: config.tilePx, maxzoom: providers.qld.maxzoom, bounds: [137.8, -37.6, 162.7, -9], attribution: `${providers.qld.attribution}; ${providers.nsw.attribution}` },
      providers: Object.values(providers).map(p => ({
        id: p.id, name: p.name, type: p.type, bounds: p.bounds, center: p.center, zoom: p.zoom,
        minzoom: p.minzoom, maxzoom: p.maxzoom, tileSize: p.type === 'raster' ? 256 : config.tilePx,
        attribution: p.attribution, style: `/styles/${p.id}.json`,
        raster: `${origin(req)}/raster/${p.id}/{z}/{x}/{y}.png`,
      })),
    });
  });
  async function style(req, res) {
    const p = providerFor(req);
    res.set('Cache-Control', 'no-cache').json(absoluteStyle((await styles.get(p)).style, origin(req)));
  }
  app.get('/style.json', style);
  app.get('/styles/:provider.json', style);
  app.get('/vector/:provider/:z/:x/:y.pbf', vector);
  app.get('/vector/:z/:x/:y.pbf', vector);
  app.get('/raster/:provider/:z/:x/:y.png', raster);
  app.get('/raster/:z/:x/:y.png', automaticRaster);
  for (const [old, current, extension] of [['tiles_raster', 'raster', 'png'], ['tiles_vector', 'vector', 'pbf']]) {
    app.get(`/${old}/:z/:x/:y.${extension}`, (req, res) => {
      if (!parseTile(req.params)) throw httpError('Invalid tile coordinates', 400);
      res.redirect(308, `/${current}/${req.params.z}/${req.params.x}/${req.params.y}.${extension}`);
    });
  }
  app.use('/fonts', express.static(config.fontDir));
  app.get('/resources/:provider/fonts/:fontstack/:range.pbf', async (req, res) => {
    const p = providerFor(req, 'vector');
    const { fontstack, range } = req.params;
    const match = /^(\d+)-(\d+)$/.exec(range);
    if (!match || Number(match[1]) % 256 || Number(match[2]) !== Number(match[1]) + 255 || Number(match[2]) > 65535 || !/^[\p{L}\p{N} ,_-]{1,200}$/u.test(fontstack)) throw httpError('Invalid font resource', 400);
    const url = `${p.resourceBase}/fonts/${encodeURIComponent(fontstack)}/${range}.pbf`;
    const file = path.join(config.resourceDir, 'v2', p.id, hash(url), `${range}.pbf`);
    const result = await cache.get({ file, url, ttl: config.resourceTTL, allowEmpty: false, priority: resourcePriority(req) });
    headers(res); await sendFile(res, result.path, 'application/x-protobuf');
  });
  app.get('/resources/:provider/sprites/:file', async (req, res) => {
    const p = providerFor(req, 'vector');
    const name = req.params.file;
    if (!/^sprite(@2x)?\.(png|json)$/.test(name)) throw httpError('Invalid sprite resource', 400);
    const url = `${p.resourceBase}/sprites/${name}`;
    const kind = name.endsWith('.png') ? 'image' : 'json';
    const result = await cache.get({ file: path.join(config.resourceDir, 'v2', p.id, hash(url), name), url, ttl: config.resourceTTL, kind, allowEmpty: false, priority: resourcePriority(req) });
    headers(res); await sendFile(res, result.path, kind === 'image' ? 'image/png' : 'application/json');
  });
  app.use('/assets', express.static(path.join(config.root, 'assets')));
  app.use('/vendor/maplibre', express.static(path.join(config.root, 'node_modules/maplibre-gl/dist'), { maxAge: '1d', index: false }));
  app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
  app.get('/readyz', (_req, res) => res.set('Cache-Control', 'no-store').json({
    status: 'ok', startedAt, version: require('./package.json').version,
    revision: process.env.BUILD_REVISION || 'development',
    settings: { tilePx: config.tilePx, pngCompression: config.pngCompression, renderConcurrency: config.renderConcurrency, renderQueueLimit: config.renderQueueLimit, upstreamConcurrency: config.upstreamConcurrency, prefetchConcurrency: config.prefetchConcurrency, prefetchRadius: config.prefetchRadius, prefetchZoom: config.prefetchZoom },
    providers: Object.keys(providers), renderer: renderer.stats, cache: cache.stats, prefetch: prefetch.stats,
    requests: requests.stats, styles: styles.stats,
  }));
  app.get('/status', (_req, res) => res.sendFile(path.join(config.root, 'public/status.html')));
  app.get('/raster', (_req, res) => res.redirect(302, '/?mode=raster'));
  app.use(express.static(path.join(config.root, 'public')));
  app.use((err, req, res, next) => {
    L.err('HTTP', `${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return next(err);
    res.set('Cache-Control', 'no-store');
    const status = err.status && err.status >= 400 && err.status <= 599 ? err.status : 502;
    if (status === 503) res.set('Retry-After', '3');
    res.status(status).json({ error: status === 400 || status === 404 ? err.message : 'Map service temporarily unavailable; please retry.' });
  });
  return { app, providers, close() { prefetch.close(); stopCleaner(); renderer.close(); cache.close?.(); } };
}
async function main() {
  const config = loadConfig();
  const instance = await createApp(config);
  const server = instance.app.listen(config.port, '0.0.0.0', () => {
    instance.app.locals.internalOrigin = `http://127.0.0.1:${server.address().port}`;
    L.sys(`Listening on port ${server.address().port}; /raster/{z}/{x}/{y}.png serves QLD + NSW vectors automatically (${config.tilePx}px)`);
    L.sys(`Render concurrency ${config.renderConcurrency}; prefetch ${config.prefetchRadius ? `up to ${config.prefetchConcurrency} tiles, radius ${config.prefetchRadius}, zoom ${config.prefetchZoom ? '±1' : 'off'}` : 'off'}`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    instance.close(); server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (require.main === module) main().catch(err => { L.err('BOOT', err.stack); process.exit(1); });
module.exports = { createApp };
