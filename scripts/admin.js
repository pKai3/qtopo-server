#!/usr/bin/env node
const { setTimeout: sleep } = require('node:timers/promises');
const { options } = require('./load-tiles');
const { requestControl } = require('../lib/local-control');

async function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args;
  if (!command || command === '--help') {
    console.log('Run inside the QTopo container:\n  node scripts/admin.js test [--z 16 --x 60500 --y 37950 --width 8 --height 8 --concurrency 8]\n  node scripts/admin.js stop-test\n  node scripts/admin.js clear-cache --confirm\n  node scripts/admin.js status\n\nThese controls use a private local socket, never the public web server. Cache clearing keeps downloaded vectors and styles.');
    return;
  }
  let state, kind;
  if (command === 'test') {
    if (flags.includes('--url')) throw new Error('The test always targets this container. --url is not supported.');
    const { url, ...settings } = options(flags);
    state = await requestControl('/tile-test/start', settings); kind = 'test';
  } else if (command === 'clear-cache' && flags.length === 1 && flags[0] === '--confirm') {
    state = await requestControl('/cache/clear', { confirm: 'clear-rendered-tiles' }); kind = 'clearing';
  } else if (command === 'status' && !flags.length) {
    console.log(JSON.stringify(await requestControl('/status'), null, 2)); return;
  } else if (command === 'stop-test' && !flags.length) {
    console.log(JSON.stringify(await requestControl('/tile-test/stop', {}), null, 2)); return;
  } else throw new Error('Unknown command or missing --confirm. Use --help.');
  const stop = () => {
    if (kind === 'test') requestControl('/tile-test/stop', {}).catch(error => console.error(error.message));
  };
  process.once('SIGINT', stop);
  try {
    let previous;
    while (true) {
      const current = state[kind];
      const message = kind === 'test' ? `${current.phase}: ${(current.progress?.succeeded || 0) + (current.progress?.failed || 0)}/${current.progress?.requested || 0} tiles finished` : `${current.phase}: ${current.removed} rendered tiles removed`;
      if (message !== previous) { console.log(message); previous = message; }
      if (!['running', 'stopping', 'waiting', 'clearing'].includes(current.phase)) {
        if (current.phase === 'error') throw new Error(current.error);
        console.log(JSON.stringify(current.result || current, null, 2));
        if (current.result?.failed) process.exitCode = 1;
        return;
      }
      await sleep(500);
      state = await requestControl('/status');
    }
  } finally { process.removeListener('SIGINT', stop); }
}

if (require.main === module) main().catch(error => {
  console.error(['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(error.code) ? 'Run this command inside the running QTopo container as root or the server user.' : error.message);
  process.exitCode = 1;
});
module.exports = { main };
