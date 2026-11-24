function readiness({ renderer = {}, cache = {}, storage = {}, stopping = false, maintenance = false, requestTimeoutMs = 120000 } = {}) {
  const reasons = [];
  const add = (code, message) => reasons.push({ code, message });
  if (stopping) add('stopping', 'The server is shutting down.');
  if (maintenance) add('maintenance', 'Rendered tiles are being cleared.');
  if (storage.readFailed) add('storage-check-failed', 'Cache storage could not be checked.');
  else if (storage.pressure || storage.blocked) add('storage-pressure', 'Cache storage limits need attention.');
  if (renderer.memory?.readFailed) add('memory-check-failed', 'Render admission is waiting for a valid memory reading.');
  if (renderer.consecutiveFailures >= 3) add('render-failures', 'Three or more consecutive renders have failed.');
  if (renderer.queued && renderer.oldestQueuedMs >= requestTimeoutMs) add('render-queue-stalled', 'Render work has been waiting longer than the request deadline.');
  for (const [provider, state] of Object.entries(cache.providers || {})) {
    if (state.consecutiveFailures >= 3) add(`resources-${provider}`, `${provider.toUpperCase()} map resources have repeatedly failed to load.`);
  }
  return { ready: !reasons.length, status: reasons.length ? 'degraded' : 'ok', reasons };
}
module.exports = { readiness };
