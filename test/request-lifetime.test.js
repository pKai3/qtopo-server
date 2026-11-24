const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestLifetime } = require('../lib/request-lifetime');

test('the request deadline includes time before a worker starts', async () => {
  const req = new EventEmitter(), res = new EventEmitter();
  const lifetime = createRequestLifetime(req, res, 20);
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(lifetime.wait(new Promise(() => {})), { status: 504 });
    assert.equal(lifetime.signal.aborted, true);
  } finally { lifetime.close(); clearTimeout(keepAlive); }
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('disconnect aborts only its own request and completed delivery is not cancellation', async () => {
  const req = new EventEmitter(), res = new EventEmitter();
  const first = createRequestLifetime(req, res, 1000);
  const otherReq = new EventEmitter(), otherRes = new EventEmitter();
  const other = createRequestLifetime(otherReq, otherRes, 1000);
  try {
    res.emit('close');
    assert.equal(first.signal.reason.status, 499);
    assert.equal(other.signal.aborted, false);
    otherRes.writableFinished = true; otherRes.emit('close');
    assert.equal(other.signal.aborted, false);
    assert.equal(await other.wait(Promise.resolve('delivered')), 'delivered');
  } finally { first.close(); other.close(); }
});
