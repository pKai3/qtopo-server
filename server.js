#!/usr/bin/env node
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const L = require('./lib/logger');
const { loadConfig } = require('./lib/config');
const { createProfileCatalog } = require('./lib/profile-files');
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
const { metatileLayout } = require('./lib/metatile');
const { createStatusActions } = require('./lib/status-actions');
const { createAdminAccess } = require('./lib/admin-access');
const { listenControl, socketPath } = require('./lib/local-control');
const { createRequestFocus } = require('./lib/request-focus');
const { mergeClientQueues } = require('./lib/client-queues');
const { createRenderFlyby } = require('./lib/render-flyby');
const { normalizeVectorValues } = require('./lib/vector-values');

async function createApp(config = loadConfig(), dependencies = {}) {
  const admin = createAdminAccess(config);
  process.umask(0o002);
  const providers = dependencies.providers || createProviders(config);
  await seedStyles(config, providers);
  const profileCatalog = createProfileCatalog(config, L);
  await profileCatalog.refresh(true);
  if (!profileCatalog.get(config.defaultProfile)) throw new Error(`Unknown DEFAULT_PROFILE: ${config.defaultProfile}`);
  const styles = createStyleCache(config), requests = createRequestMetrics();
  const startedAt = new Date().toISOString();
  for (const dir of [config.vectorDir, config.rasterDir, config.resourceDir]) await fs.mkdir(path.join(dir, 'v2'), { recursive: true });
  if (config.clearRaster) await fs.rm(path.join(config.rasterDir, 'v2'), { recursive: true, force: true });
  const cache = dependencies.cache || createCache({ timeoutMs: config.upstreamTimeoutMs, emptyTTL: config.emptyTTL, concurrency: config.upstreamConcurrency, logger: L });
  const flyby = dependencies.flyby || createRenderFlyby();
  const renderer = dependencies.renderer || createRenderer(config, undefined, flyby);
  const requestFocus = createRequestFocus({ distance: config.requestPanThreshold });
  const nativeZoom = dependencies.nativeZoom || createTileIndex(config, cache);
  const stopCleaner = startCleaner(config, L);
  const app = express();
  const interruptedResponses = new WeakSet();
  app.set('trust proxy', admin.trustProxy);
  let activeRasterRequests = 0;
  const prefetch = createPrefetch({
    radius: config.prefetchRadius, zoom: config.prefetchZoom, concurrency: config.prefetchConcurrency,
    limit: config.prefetchQueueLimit, logger: L,
    zoomRange: source => {
      const [, id] = source.split(':');
      return id === 'auto' ? { minzoom: 0, maxzoom: providers.qld.maxzoom } : providers[id];
    },
    groupKey: (source, tile) => {
      const [profile, id] = source.split(':');
      // Only QLD has one vector style variant across the whole metatile.
      // NSW variants, border composites and image tiles retain per-tile slots.
      if (id !== 'qld' && !(id === 'auto' && coverage(tile).region === 'qld')) return;
      const layout = metatileLayout(tile, config);
      return `${profile}/qld/${tile.z}/${layout.x}/${layout.y}`;
    },
    render: async (source, tile, priority, rank, interest) => {
      const [key, id] = source.split(':');
      const [profileId, token] = key.split('@');
      const profile = profileCatalog.get(profileId);
      if (!profile || profile.token !== token) return; // Superseded speculative work.
      const result = await (id === 'auto' ? automaticRasterFile(tile, priority, rank, interest, profile) : rasterFile(providers[id], tile, priority, rank, interest, profile));
      requests.prefetched(result);
    },
  });
  const actions = createStatusActions({
    origin: () => app.locals.internalOrigin, rasterDir: path.join(config.rasterDir, 'v2'), maxzoom: providers.qld.maxzoom,
    busy: () => { const render = renderer.stats; return activeRasterRequests || render?.active || render?.queued || prefetch.stats.active; },
    pause: () => prefetch.pause(), resume: () => prefetch.resume(), logger: L,
    readStatus: () => status(),
  });
  app.disable('x-powered-by');
  const shortTile = /^\/(\d+)\/(\d+)\/(\d+)\.png$/;
  const profileTile = /^\/([a-z][a-z0-9-]*)\/(\d+)\/(\d+)\/(\d+)\.png$/;
  // Public map data can be used directly by Gaia and other browser clients.
  // Keep status/log endpoints outside this policy, and never enable credentials.
  app.use(['/raster', '/vector', '/tiles_raster', '/tiles_vector', '/styles', '/style.json', '/fonts', '/resources', '/assets', '/api/providers', shortTile, profileTile], (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', 'ETag, Retry-After, X-QTopo-Profile');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Accept, Content-Type, If-None-Match, If-Modified-Since, Range');
      res.set('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  });
  app.use((req, res, next) => {
    if (shortTile.test(req.path) || profileTile.test(req.path) || /^\/(raster|vector|tiles_raster|tiles_vector)\//.test(req.path)) {
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
  async function profileFor(req) {
    await profileCatalog.refresh();
    const id = req.params.profile || config.defaultProfile;
    const profile = profileCatalog.get(id);
    if (!profile) throw httpError('Unknown map profile', 404);
    return profile;
  }
  function coordinates(req, p) {
    const tile = parseTile(req.params, p.maxzoom);
    if (!tile) throw httpError('Invalid tile coordinates or zoom', 400);
    return tile;
  }
  function headers(res, seconds = 3600) { res.set('Cache-Control', `public, max-age=${seconds}`); }
  function sendFile(res, file, type) {
    res.type(type);
    return new Promise((resolve, reject) => res.sendFile(file, err => {
      if (!err) return resolve();
      if ((res.destroyed || res.req.aborted || res.req.socket.destroyed) && ['ECONNABORTED', 'ECONNRESET', 'EPIPE'].includes(err.code)) interruptedResponses.add(err);
      reject(err);
    }));
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
    if (p.id === 'qld' && req.query.values === '2') return res.type('application/x-protobuf').send(normalizeVectorValues(await fs.readFile(result.path)));
    await sendFile(res, result.path, 'application/x-protobuf');
  }
  async function styleForRaster(p, tile, profile) {
    const prepared = await styles.get(p, profile);
    return p.tileMap ? prepared.atZoom(await nativeZoom(p, tile)) : prepared;
  }
  const renderTag = priority => ['RDR', 'PREFETCH', 'PREFETCH-Z'][priority];
  async function rasterFile(p, tile, priority = PRIORITY.REQUEST, rank = 0, interest, profile = profileCatalog.get(config.defaultProfile)) {
    const { style, revision } = await styleForRaster(p, tile, profile);
    const outPath = path.join(config.rasterDir, 'v2', p.id, revision, String(tile.z), String(tile.x), `${tile.y}.png`);
    let cached = await cachedRaster(outPath, config.rasterTTL, config.emptyTTL);
    const hit = !!cached;
    if (!cached) {
      L.log(renderTag(priority), `Generating tile: ${outPath}`);
      const job = { ...tile, outPath, priority, rank, profile: profile.id, styleKey: revision, size: p.type === 'raster' ? 256 : config.tilePx };
      if (p.type === 'raster') {
        const image = await cache.get({
          file: path.join(config.resourceDir, 'v2', p.id, p.cacheId, String(tile.z), String(tile.x), `${tile.y}.image`),
          url: tileURL(p, tile.z, tile.x, tile.y), ttl: config.rasterTTL, kind: 'image', logTag: 'IMG', priority,
        });
        Object.assign(job, { kind: 'image', inputPath: image.empty ? null : image.path });
      } else {
        const internalOrigin = app.locals.internalOrigin;
        if (!internalOrigin) throw httpError('Renderer not ready', 503);
        const layout = metatileLayout(tile, config);
        // Sparse NSW coverage can change source zoom within a grid. Only save
        // siblings that use this exact style variant; never cache reduced detail
        // under another tile's higher-resolution revision.
        const variants = p.tileMap ? await Promise.all(layout.tiles.map(t => styleForRaster(p, t, profile))) : layout.tiles.map(() => ({ revision }));
        const outputs = layout.tiles.filter((_, i) => variants[i].revision === revision).map(t => ({
          ...t, outPath: path.join(config.rasterDir, 'v2', p.id, revision, String(t.z), String(t.x), `${t.y}.png`),
        }));
        Object.assign(job, { kind: 'vector', layout, outputs,
          renderKey: path.join(config.rasterDir, 'v2', p.id, revision, 'metatile', String(tile.z), `${layout.x}-${layout.y}`),
          origin: internalOrigin, style: absoluteStyle(renderStyle(style, config.labelScale, p.id === 'qld'), internalOrigin),
        });
      }
      await renderer.render(job, interest);
      cached = await cachedRaster(outPath, config.rasterTTL, config.emptyTTL);
    } else if (priority === PRIORITY.REQUEST) L.log('RDR', `Cached tile: ${outPath}`);
    if (!cached) throw httpError('Rendered tile is unavailable');
    return { path: outPath, empty: cached.empty, hit };
  }
  async function deliverRaster(res, result, profile) {
    if (result.empty) L.log('RDR', `Empty tile: ${result.path}`);
    headers(res, profile.styles ? 0 : result.empty ? Math.floor(config.emptyTTL / 1000) : 3600);
    res.set('X-QTopo-Profile', profile.id);
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
    // Listen before style discovery can yield: the client may disconnect while
    // the live catalog is being read, before any rendering has started.
    const measured = requests.begin();
    res.once('finish', () => measured.finish(res.statusCode, false, res.statusCode === 304 ? 0 : res.getHeader('content-length')));
    res.once('close', () => { if (!res.writableFinished) measured.finish(res.statusCode, true); });
    const profile = await profileFor(req);
    if (req.aborted || res.destroyed) return;
    if (actions.cacheBusy) throw httpError('Rendered tiles are being cleared; please retry shortly.', 503);
    const tile = coordinates(req, p || providers.qld);
    L.log('PROFILE', `${profile.id} ${tile.z}/${tile.x}/${tile.y}`);
    activeRasterRequests++;
    const focus = requestFocus.observe(req.ip, tile), interest = focus.forTile(tile);
    const finish = prefetch.begin(`${profile.id}@${profile.token}:${p?.id || 'auto'}`, tile, focus);
    let success = false;
    try {
      const result = await (p ? rasterFile(p, tile, PRIORITY.REQUEST, 0, interest, profile) : automaticRasterFile(tile, PRIORITY.REQUEST, 0, interest, profile));
      if (req.aborted || res.destroyed) return;
      measured.ready(result);
      await deliverRaster(res, result, profile);
      success = true;
    } finally { activeRasterRequests--; finish(success); }
  }
  async function automaticRasterFile(tile, priority = PRIORITY.REQUEST, rank = 0, interest, profile = profileCatalog.get(config.defaultProfile)) {
    const area = coverage(tile);
    if (priority === PRIORITY.REQUEST) L.log('AUTO', `${tile.z}/${tile.x}/${tile.y}: ${area.region === 'border' ? 'QLD + NSW border' : area.region.toUpperCase()} vectors`);
    if (area.region === 'qld') return rasterFile(providers.qld, tile, priority, rank, interest, profile);
    if (area.region === 'nsw') return rasterFile(providers.nsw, tile, priority, rank, interest, profile);
    const [qldStyle, nswStyle] = await Promise.all([styleForRaster(providers.qld, tile, profile), styleForRaster(providers.nsw, tile, profile)]);
    const revision = hash(JSON.stringify({ version: 2, boundaryRevision, qld: qldStyle.revision, nsw: nswStyle.revision }));
    const outPath = path.join(config.rasterDir, 'v2', 'auto', revision, String(tile.z), String(tile.x), `${tile.y}.png`);
    let cached = await cachedRaster(outPath, config.rasterTTL, config.emptyTTL);
    const hit = !!cached;
    if (!cached) {
      L.log(renderTag(priority), `Generating border tile: ${outPath}`);
      const [backgroundPath, foregroundPath] = await Promise.all([rasterFile(providers.qld, tile, priority, rank, interest, profile), rasterFile(providers.nsw, tile, priority, rank, interest, profile)]);
      const rect = [0, 0, config.tilePx, config.tilePx];
      await renderer.render({ ...tile, outPath, priority, rank, profile: profile.id, size: config.tilePx, kind: 'composite', backgroundPath: backgroundPath.path, images: [{ path: foregroundPath.path, source: rect, destination: rect }], clip: area.rings }, interest);
      cached = await cachedRaster(outPath, config.rasterTTL, config.emptyTTL);
    } else if (priority === PRIORITY.REQUEST) L.log('RDR', `Cached border tile: ${outPath}`);
    if (!cached) throw httpError('Rendered border tile is unavailable');
    return { path: outPath, empty: cached.empty, hit };
  }

  app.get('/api/providers', async (req, res) => {
    await profileCatalog.refresh();
    res.set('Cache-Control', 'no-cache').json({
      defaultProvider: config.defaultProvider, defaultProfile: config.defaultProfile,
      profiles: profileCatalog.list().map(p => ({ id: p.id, name: p.name, factor: p.factor, refined: p.refined, raster: `${origin(req)}/${p.id}/{z}/{x}/{y}.png` })),
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
    const browserStyle = absoluteStyle((await styles.get(p, await profileFor(req))).style, origin(req));
    // Bypass previously cached raw Esri tiles without invalidating PNG caches.
    if (p.id === 'qld') for (const source of Object.values(browserStyle.sources || {})) {
      if (source.type === 'vector') source.tiles = source.tiles.map(url => `${url}?values=2`);
    }
    res.set('Cache-Control', 'no-cache').json(browserStyle);
  }
  app.get('/style.json', style);
  app.get('/styles/:provider.json', style);
  app.get('/styles/:profile/:provider.json', style);
  app.get('/vector/:provider/:z/:x/:y.pbf', vector);
  app.get('/vector/:z/:x/:y.pbf', vector);
  app.get('/raster/:profile/:provider/:z/:x/:y.png', raster);
  app.get('/raster/:provider/:z/:x/:y.png', raster);
  app.get('/raster/:z/:x/:y.png', automaticRaster);
  app.get(shortTile, (req, res) => {
    req.params = { z: req.params[0], x: req.params[1], y: req.params[2] };
    return automaticRaster(req, res);
  });
  app.get(profileTile, (req, res) => {
    req.params = { profile: req.params[0], z: req.params[1], x: req.params[2], y: req.params[3] };
    return automaticRaster(req, res);
  });
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
  function status() { return {
    status: 'ok', startedAt, version: require('./package.json').version,
    revision: process.env.BUILD_REVISION || 'development',
    settings: { defaultProfile: config.defaultProfile, tilePx: config.tilePx, metatileSize: config.metatileSize, renderBufferPx: config.renderBufferPx, pngCompression: config.pngCompression, renderConcurrency: config.renderConcurrency, renderQueueLimit: config.renderQueueLimit, requestPanThreshold: config.requestPanThreshold, upstreamConcurrency: config.upstreamConcurrency, prefetchConcurrency: config.prefetchConcurrency, prefetchQueueLimit: config.prefetchQueueLimit, prefetchRadius: config.prefetchRadius, prefetchZoom: config.prefetchZoom },
    providers: Object.keys(providers), renderer: renderer.stats, cache: cache.stats, prefetch: prefetch.stats,
    requests: requests.stats, styles: styles.stats,
  }; }
  app.use(['/status', '/status.html', '/status.js', '/status.css', '/readyz'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/readyz', (req, res) => {
    const data = status();
    // Aggregate activity is public; individual tile locations and test areas
    // must not be disclosed through the read-only dashboard.
    const { lastRender, ...renderStats } = data.renderer || {};
    if (req.query.clients === '1') data.clientQueues = mergeClientQueues(renderer.clientQueues || [], prefetch.clientQueues || []);
    res.json({ ...data, renderer: renderStats, logsAvailable: admin.canReadLogs(req), flybyAvailable: true });
  });
  // Retired web controls fail for every client, including localhost and
  // trusted proxies. Maintenance is exposed only on the private Unix socket.
  app.use('/api/actions', (_req, res) => res.status(404).set('Cache-Control', 'no-store').json({ error: 'Web controls are unavailable. Use the container CLI.' }));
  for (const [routes, file] of [[['/status', '/status.html'], 'status.html'], ['/status.js', 'status.js'], ['/status.css', 'status.css']]) {
    app.get(routes, (_req, res) => res.sendFile(path.join(config.root, 'admin', file), { cacheControl: false }));
  }
  app.get('/api/logs', admin.authorize, (req, res) => {
    const after = req.query.after ?? '0', session = req.query.session;
    if (typeof after !== 'string' || !/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)) || (session != null && (typeof session !== 'string' || session.length > 64))) throw httpError('Invalid log cursor', 400);
    res.set('Cache-Control', 'no-store').json(L.read(Number(after), session));
  });
  app.get('/api/render-flyby', (req, res) => {
    const after = req.query.after ?? '0', session = req.query.session;
    if (typeof after !== 'string' || !/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)) || (session != null && (typeof session !== 'string' || session.length > 64))) throw httpError('Invalid preview cursor', 400);
    res.set('Cache-Control', 'no-store').json(flyby.read(Number(after), session));
  });
  app.get('/raster', (_req, res) => res.redirect(302, '/?mode=raster'));
  app.use(express.static(path.join(config.root, 'public')));
  app.use((err, req, res, next) => {
    // A cancelled map download is already counted/logged by the close handler.
    // Do not send another response or ask Express to print a duplicate stack.
    if (interruptedResponses.has(err)) return;
    L.err('HTTP', `${req.method} ${req.path}: ${err.message}`);
    if (req.aborted || res.destroyed) return;
    if (res.headersSent) return next(err);
    res.set('Cache-Control', 'no-store');
    const status = err.status && err.status >= 400 && err.status <= 599 ? err.status : 502;
    if (status === 503) res.set('Retry-After', '3');
    res.status(status).json({ error: status === 400 || status === 404 ? err.message : 'Map service temporarily unavailable; please retry.' });
  });
  return { app, providers, actions, close() { actions.close(); prefetch.close(); stopCleaner(); renderer.close(); cache.close?.(); } };
}
async function main() {
  const config = loadConfig();
  const instance = await createApp(config);
  const control = await listenControl(instance.actions, socketPath(config.port));
  const server = instance.app.listen(config.port, '0.0.0.0', () => {
    instance.app.locals.internalOrigin = `http://127.0.0.1:${server.address().port}`;
    L.sys(`Listening on port ${server.address().port}; /raster/{z}/{x}/{y}.png serves QLD + NSW vectors automatically (${config.tilePx}px)`);
    L.sys(`Render concurrency ${config.renderConcurrency}; prefetch ${config.prefetchRadius ? `up to ${config.prefetchConcurrency} tiles, radius ${config.prefetchRadius}, zoom ${config.prefetchZoom ? '±1' : 'off'}` : 'off'}`);
    L.sys(`Vector renders ${config.metatileSize}×${config.metatileSize} tiles with ${config.renderBufferPx}px logical padding; each output remains ${config.tilePx}px`);
    L.sys('Status is public and read-only. Tests and cache clearing require the container CLI; application logs retain their network restrictions.');
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    instance.close(); control.close(); server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (require.main === module) main().catch(err => { L.err('BOOT', err.stack); process.exit(1); });
module.exports = { createApp };
