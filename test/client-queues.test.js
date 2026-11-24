const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequestFocus, rememberInterest } = require('../lib/request-focus');
const { interestClients, summarizeClientQueues, mergeClientQueues } = require('../lib/client-queues');

test('client summaries anonymize addresses, deduplicate a client and count shared work once', () => {
  const focus = createRequestFocus(), tile = {z:17,x:121026,y:76203};
  const a = focus.observe('192.0.2.73', tile), b = focus.observe('2001:db8::99', tile);
  const interests = new Map();
  rememberInterest(interests, a.forTile(tile));
  rememberInterest(interests, a.forTile({...tile,x:tile.x+1}));
  const single = summarizeClientQueues([{state:'rendering',priority:0,clients:interestClients(interests)}]);
  assert.equal(single.length,1); assert.equal(single[0].id,'client-1'); assert.equal(single[0].rendering.requested,1);
  rememberInterest(interests,b.forTile(tile));
  const shared = summarizeClientQueues([{state:'waiting',priority:1,clients:interestClients(interests)}]);
  const merged = mergeClientQueues(single, shared, summarizeClientQueues([{state:'waiting',priority:2}]));
  assert.deepEqual(merged.map(row=>row.id),['client-1','shared','other']);
  assert.equal(merged[1].waiting.neighbours,1);
  assert.equal(merged[2].waiting.zoom,1);
  assert.doesNotMatch(JSON.stringify(merged),/192\.0\.2|2001:db8|121026|76203/);
});

test('client identity expires and nested prefetch attribution follows live interests', () => {
  let now = 0;
  const focus = createRequestFocus({now:()=>now,ttlMs:100}), tile = {z:10,x:1,y:1};
  const interests = new Map();
  rememberInterest(interests,focus.observe('address',tile).forTile(tile));
  const nested = new Map([['prefetch/internal-tile-key',{clients:()=>interestClients(interests)}]]);
  assert.deepEqual(interestClients(nested),[1]);
  now=100;
  assert.deepEqual(interestClients(nested),[]);
  rememberInterest(interests,focus.observe('address',tile).forTile(tile));
  assert.deepEqual(interestClients(nested),[2]);
});
