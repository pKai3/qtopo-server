// Run against the Linux CI server as its Unraid user, never against production.
const assert = require('node:assert/strict');
const { main: profiles } = require('./profiles');
const { syncProfile } = require('../lib/profile-files');
const { loadConfig } = require('../lib/config');
const origin = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const pause = () => new Promise(resolve => setTimeout(resolve, 300));
async function main() {
  const config = loadConfig(), before = await (await fetch(origin + '/readyz')).json();
  const original = await profiles(['export', 'mobile-3x', '-'], config);
  original.id = 'ci-live-sync'; original.name = 'CI live sync';
  const route = '/ci-live-sync/15/30311/18988.png';
  async function tile() {
    await pause();
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200, response.ok ? '' : await response.text());
    assert.equal(response.headers.get('x-qtopo-profile'), original.id);
    assert.match(response.headers.get('cache-control'), /max-age=0/);
    return Buffer.from(await response.arrayBuffer());
  }
  await syncProfile(config, original);
  const first = await tile(), changed = structuredClone(original);
  const roads = changed.styles.qld.layers.filter(l => l.id.startsWith('roads-') && l.type === 'line');
  assert.ok(roads.length);
  for (const road of roads) road.paint['line-color'] = '#f000f0';
  await syncProfile(config, changed);
  const second = await tile();
  assert.notDeepEqual(second, first, 'same URL must render new pixels after a live sync');
  const invalid = structuredClone(changed); invalid.styles.qld.layers.find(l => l.type === 'line').paint['line-width'] = 'invalid';
  await assert.rejects(syncProfile(config, invalid));
  assert.deepEqual(await tile(), second, 'invalid sync must retain the valid map');
  await syncProfile(config, original);
  assert.deepEqual(await tile(), first, 'rollback restores the original pixels and cache');
  const after = await (await fetch(origin + '/readyz')).json();
  assert.equal(after.startedAt, before.startedAt);
  assert.equal(after.revision, before.revision);
  assert.equal(after.settings.defaultProfile, 'classic');
  console.log('Native live profile sync passed: changed pixels, invalid rejection, rollback, unchanged server start/revision/default');
}
main().catch(error => { console.error(error); process.exit(1); });
