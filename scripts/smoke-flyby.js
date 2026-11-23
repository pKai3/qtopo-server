const assert = require('node:assert/strict');
const { loadImage } = require('canvas');
const origin = 'http://127.0.0.1:8080';
(async () => {
  let cursor = await (await fetch(origin + '/api/render-flyby')).json(), entries = [], running = true, pollingError;
  const watch = (async () => {
    while (running) {
      try {
        const response = await fetch(`${origin}/api/render-flyby?after=${cursor.next}&session=${cursor.session}`, { signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        cursor = await response.json(); entries.push(...cursor.entries);
      } catch (error) { pollingError = error; break; }
      await new Promise(r => setTimeout(r, 250));
    }
  })();
  try {
    const tile = await fetch(origin + '/mobile-3x/17/121246/75948.png', { signal: AbortSignal.timeout(60000) });
    assert.equal(tile.status, 200); await tile.arrayBuffer();
    for (let i = 0; i < 40 && !entries.length; i++) await new Promise(r => setTimeout(r, 100));
    assert.ifError(pollingError); assert.ok(entries.length, 'a completed native tile produces a sampled preview');
    const preview = entries[0], image = await loadImage(preview.image);
    assert.equal(image.width, 160); assert.equal(image.height, 160);
    assert.ok(preview.image.length < 44024); assert.equal(preview.profile, 'mobile-3x');
    console.log('Native tile flyby passed: bounded 160px preview of an existing render.');
  } finally { running = false; await watch; }
})().catch(error => { console.error(error); process.exitCode = 1; });
