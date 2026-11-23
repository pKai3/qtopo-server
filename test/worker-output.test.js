const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { forwardWorkerOutput } = require('../lib/worker-output');
test('native output preserves split lines, bounds long lines and flushes unterminated crash text', async () => {
  const stream = new PassThrough(), lines = [];
  forwardWorkerOutput(stream, line => lines.push(line));
  stream.write('Failed to open '); stream.write('X display\r\n');
  stream.write('x'.repeat(20000)); stream.end('\nfatal without newline');
  await once(stream, 'end');
  assert.equal(lines[0], 'Failed to open X display');
  assert.equal(lines.slice(1, -1).join(''), 'x'.repeat(20000));
  assert.equal(lines.at(-1), 'fatal without newline');
  assert.ok(lines.every(line => line.length <= 8192));
});
