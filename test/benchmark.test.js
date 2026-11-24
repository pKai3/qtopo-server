'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareTrace } = require('../scripts/benchmark/run');
const directory = path.join(__dirname, '../scripts/benchmark/traces');

test('bundled traces work in a clean checkout without capture files', () => {
  prepareTrace(JSON.parse(fs.readFileSync(path.join(directory,'synthetic.json'))), 'synthetic');
  for (const file of ['phone.json','phone-pauses.json','computer.json']) {
    const original = JSON.parse(fs.readFileSync(path.join(directory,file)));
    assert.equal(original.coordinates,'relative');
    assert.equal(original.recordedAt,undefined);
    const snapshot=JSON.stringify(original);
    for (const mode of ['clock','paced','partial']) {
      const ready=prepareTrace(original,mode);
      assert.ok(ready.requests.length>100);
      for (let i=0;i<ready.requests.length;i++) {
        const before=original.requests[i],after=ready.requests[i];
        assert.equal(after.t,before.t);
        assert.equal(after.group,before.group);
        assert.equal(after.durationMs,before.durationMs);
        assert.equal(after.outcome,before.outcome);
        assert.equal(after.path,undefined);
        assert.equal(after.x-before.x,original.anchor.x*2**(after.z-original.baseZoom));
        assert.equal(after.y-before.y,original.anchor.y*2**(after.z-original.baseZoom));
      }
    }
    assert.equal(JSON.stringify(original),snapshot);
  }
});

test('rejects unsafe routes and malformed cancellation timing before a run', () => {
  const trace={kind:'human-phone',requests:[{profile:'mobile',z:4,x:1,y:1,t:0,group:0}]};
  const invalid=change=>prepareTrace({...trace,requests:[{...trace.requests[0],...change}]},'partial');
  assert.throws(()=>invalid({profile:'../readyz'}));
  assert.throws(()=>invalid({x:16}));
  assert.throws(()=>invalid({z:20}));
  assert.throws(()=>invalid({t:-1}));
  assert.throws(()=>invalid({group:-1}));
  assert.throws(()=>invalid({outcome:'abandoned'}));
  assert.throws(()=>invalid({outcome:'abandoned',durationMs:-10}));
  assert.throws(()=>prepareTrace({...trace,replayPolicy:{readyFraction:0}},'partial'));
  assert.throws(()=>prepareTrace({...trace,replayPolicy:{minPauseMs:100,maxPauseMs:50}},'partial'));
});

test('raw private captures remain usable and groups must stay ordered', () => {
  const first={profile:'readable',z:12,x:3700,y:2400,t:0,group:0};
  const trace={kind:'human-computer',requests:[first,{...first,t:10,group:1,outcome:'abandoned',durationMs:30}]};
  assert.deepEqual(prepareTrace(trace,'clock'),trace);
  assert.throws(()=>prepareTrace({...trace,requests:[trace.requests[1],first]},'clock'));
});
