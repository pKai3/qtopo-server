#!/usr/bin/env node
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const L = require('./lib/logger');
const { loadConfig } = require('./lib/config');
const { createProviders, tileURL, parseTile, hash } = require('./lib/providers');
const { createCache } = require('./lib/cache');
const { cachedFile, httpError, imageType } = require('./lib/utils');
const { seedStyles, getStyle, absoluteStyle, renderStyle, styleRevision } = require('./lib/styles');
const { createRenderer } = require('./lib/render');
const { startCleaner } = require('./lib/cleaner');

async function createApp(config = loadConfig(), dependencies = {}) {
  process.umask(0o002);
  const providers = dependencies.providers || createProviders(config);
  await seedStyles(config, providers);
  for (const dir of [config.vectorDir, config.rasterDir, config.resourceDir]) await fs.mkdir(path.join(dir, 'v2'), { recursive: true });
  if (config.clearRaster) await fs.rm(path.join(config.rasterDir, 'v2'), { recursive: true, force: true });
  const cache = dependencies.cache || createCache({ timeoutMs: config.upstreamTimeoutMs, emptyTTL: config.emptyTTL });
  const renderer = dependencies.renderer || createRenderer(config);
  const stopCleaner = startCleaner(config, L);
  const app = express();
  app.disable('x-powered-by');
  const origin = req => config.publicUrl || `${req.protocol}://${req.get('host')}`;
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
      url: tileURL(p, z, x, y), ttl: config.vectorTTL,
    });
    headers(res, result.empty ? Math.floor(config.emptyTTL / 1000) : 3600);
    if (result.empty) return res.status(204).end();
    await sendFile(res, result.path, 'application/x-protobuf');
  }
  async function raster(req, res) {
    const p = providerFor(req);
    const tile = coordinates(req, p);
    const style = await getStyle(config, p);
    const revision = styleRevision(style, config, p);
    const outPath = path.join(config.rasterDir, 'v2', p.id, revision, String(tile.z), String(tile.x), `${tile.y}.png`);
    if (!(await cachedFile(outPath, config.rasterTTL))?.size) {
      const job = { ...tile, outPath, size: p.type === 'raster' ? 256 : config.tilePx };
      if (p.type === 'raster') {
        const image = await cache.get({
          file: path.join(config.resourceDir, 'v2', p.id, p.cacheId, String(tile.z), String(tile.x), `${tile.y}.image`),
          url: tileURL(p, tile.z, tile.x, tile.y), ttl: config.rasterTTL, kind: 'image',
        });
        Object.assign(job, { kind: 'image', inputPath: image.empty ? null : image.path });
      } else {
        const internalOrigin = app.locals.internalOrigin;
        if (!internalOrigin) throw httpError('Renderer not ready', 503);
        Object.assign(job, { kind: 'vector', origin: internalOrigin, style: absoluteStyle(renderStyle(style, config.labelScale), internalOrigin) });
      }
      await renderer.render(job);
    }
    headers(res);
    await sendFile(res, outPath, 'image/png');
  }

  app.get('/api/providers', (req, res) => {
    res.set('Cache-Control', 'no-cache').json({
      defaultProvider: config.defaultProvider,
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
    res.set('Cache-Control', 'no-cache').json(absoluteStyle(await getStyle(config, p), origin(req)));
  }
  app.get('/style.json', style);
  app.get('/styles/:provider.json', style);
  app.get('/vector/:provider/:z/:x/:y.pbf', vector);
  app.get('/vector/:z/:x/:y.pbf', vector);
  app.get('/raster/:provider/:z/:x/:y.png', raster);
  app.get('/raster/:z/:x/:y.png', raster);
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
    const result = await cache.get({ file, url, ttl: config.resourceTTL, allowEmpty: false });
    headers(res); await sendFile(res, result.path, 'application/x-protobuf');
  });
  app.get('/resources/:provider/sprites/:file', async (req, res) => {
    const p = providerFor(req, 'vector');
    const name = req.params.file;
    if (!/^sprite(@2x)?\.(png|json)$/.test(name)) throw httpError('Invalid sprite resource', 400);
    const url = `${p.resourceBase}/sprites/${name}`;
    const kind = name.endsWith('.png') ? 'image' : 'json';
    const result = await cache.get({ file: path.join(config.resourceDir, 'v2', p.id, hash(url), name), url, ttl: config.resourceTTL, kind, allowEmpty: false });
    headers(res); await sendFile(res, result.path, kind === 'image' ? 'image/png' : 'application/json');
  });
  app.use('/assets', express.static(path.join(config.root, 'assets')));
  app.use('/vendor/maplibre', express.static(path.join(config.root, 'node_modules/maplibre-gl/dist'), { maxAge: '1d', index: false }));
  app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
  app.get('/readyz', (_req, res) => res.json({ status: 'ok', providers: Object.keys(providers), renderer: renderer.stats, cache: cache.stats }));
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
  return { app, providers, close() { stopCleaner(); renderer.close(); } };
}
async function main() {
  const config = loadConfig();
  const instance = await createApp(config);
  const server = instance.app.listen(config.port, '0.0.0.0', () => {
    instance.app.locals.internalOrigin = `http://127.0.0.1:${server.address().port}`;
    L.sys(`Listening on port ${server.address().port}; default map ${config.defaultProvider}`);
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
