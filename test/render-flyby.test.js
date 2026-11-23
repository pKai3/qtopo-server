const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRenderFlyby } = require('../lib/render-flyby');
const image = '/9j/AA==', job = { z: 16, profile: 'mobile-light', priority: 1 };
test('preview sampling is off until watched, rate bounded and expires without a watcher', () => {
  let time = 1000;
  const flyby = createRenderFlyby({ now: () => time });
  assert.equal(flyby.reserve(), false);
  const initial = flyby.read(0);
  assert.deepEqual(initial.entries, []);
  assert.equal(flyby.reserve(), true); assert.equal(flyby.reserve(), false);
  time += 249; assert.equal(flyby.reserve(), false);
  time++; assert.equal(flyby.reserve(), true);
  flyby.publish(image, job);
  const seen = flyby.read(0, initial.session);
  assert.equal(seen.entries.length, 1); assert.equal(seen.entries[0].priority, 'nearby');
  assert.equal(flyby.read(seen.next, initial.session).entries.length, 0);
  time += 3000; assert.equal(flyby.reserve(), false);
  flyby.publish(image, job);
  assert.equal(flyby.read(seen.next, initial.session).entries.length, 0);
});
test('preview history bounds image size, batch size and age and skips old sessions', () => {
  let time = 1;
  const flyby = createRenderFlyby({ now: () => time }), initial = flyby.read(0);
  for (let i = 0; i < 80; i++) { time += 250; flyby.read(0, initial.session); flyby.publish(image, job); }
  flyby.publish('https://other/image.png', job); flyby.publish('/9j/' + 'A'.repeat(44000), job);
  const result = flyby.read(0, initial.session);
  assert.equal(result.next, 80); assert.equal(result.entries.length, 8); assert.equal(result.entries[0].id, 73);
  assert.deepEqual(flyby.read(0, 'old-session').entries, []);
  time += 15000; assert.deepEqual(flyby.read(0, initial.session).entries, []);
});
