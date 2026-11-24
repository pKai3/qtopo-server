const { httpError } = require('./utils');

function waitFor(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function createRequestLifetime(req, res, timeoutMs) {
  const controller = new AbortController();
  const disconnect = () => {
    if (!res.writableFinished) controller.abort(httpError('Tile client disconnected', 499));
  };
  const timer = setTimeout(() => controller.abort(httpError('Tile request deadline exceeded', 504)), timeoutMs);
  timer.unref();
  req.once('aborted', disconnect); res.once('close', disconnect);
  if (req.aborted || res.destroyed) disconnect();
  return {
    signal: controller.signal,
    wait: promise => waitFor(promise, controller.signal),
    close() { clearTimeout(timer); req.removeListener('aborted', disconnect); res.removeListener('close', disconnect); },
  };
}
module.exports = { createRequestLifetime, waitFor };
