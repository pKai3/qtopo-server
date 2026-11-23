const express = require('express');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');

const socketPath = (port = process.env.PORT || 8080) => path.join('/tmp', `qtopo-control-${port}`, 'control.sock');

// This listener has no TCP port. Only the server user and root can traverse
// its private directory and connect; forwarded HTTP headers grant no access.
async function listenControl(actions, socket = socketPath()) {
  const dir = path.dirname(socket);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('Unsafe local control directory');
  await fs.chmod(dir, 0o700);
  const previous = await fs.lstat(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (previous) {
    if (!previous.isSocket() || previous.uid !== process.getuid()) throw new Error('Unsafe local control socket');
    await new Promise((resolve, reject) => {
      const probe = net.createConnection(socket);
      probe.once('connect', () => { probe.destroy(); reject(new Error('A local control listener is already running')); });
      probe.once('error', error => ['ECONNREFUSED', 'ENOENT'].includes(error.code) ? resolve() : reject(error));
    });
    await fs.unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));
  app.get('/status', (_req, res) => res.json(actions.stats));
  app.post('/tile-test/start', (req, res) => res.status(202).json(actions.start(req.body)));
  app.post('/tile-test/stop', (_req, res) => res.json(actions.stop()));
  app.post('/cache/clear', (req, res) => {
    if (req.body?.confirm !== 'clear-rendered-tiles') return res.status(400).json({ error: 'Pass --confirm to clear rendered tiles.' });
    res.status(202).json(actions.clear());
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    await fs.chmod(socket, 0o600);
    return server;
  } catch (error) { server.close(); throw error; }
}

function requestControl(route, body, socket = socketPath()) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: route, method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, timeout: 10000 }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (response.statusCode >= 400) throw Object.assign(new Error(result.error), { status: response.statusCode });
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Local control request timed out')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

module.exports = { listenControl, requestControl, socketPath };
