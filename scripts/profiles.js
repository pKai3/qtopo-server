#!/usr/bin/env node
const fs = require('node:fs/promises');
const { loadConfig } = require('../lib/config');
const { createProviders } = require('../lib/providers');
const { createStyleCache } = require('../lib/styles');
const { readProfile, validateProfile, createProfileCatalog, syncProfile, MAX_BYTES } = require('../lib/profile-files');
const { formatStyleJson } = require('../lib/style-format');
async function readInput(input, stdin) {
  if (input !== '-') return readProfile(input);
  const chunks = []; let bytes = 0;
  for await (const chunk of stdin) {
    const data = Buffer.from(chunk); bytes += data.length;
    if (bytes > MAX_BYTES) throw new Error('Profile must be smaller than 8 MiB');
    chunks.push(data);
  }
  return validateProfile(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
async function main(args = process.argv.slice(2), config = loadConfig(), stdin = process.stdin) {
  const [command, input, output] = args;
  if (!command || command === '--help') {
    console.log('Run inside the container:\n  node scripts/profiles.js list\n  node scripts/profiles.js export mobile-3x /tmp/mobile-3x.json\n  node scripts/profiles.js validate /tmp/mobile-3x.json\n  node scripts/profiles.js sync /tmp/mobile-3x.json\n\nUse - instead of a filename to read stdin or export JSON to stdout. Edit the exported JSON before syncing. Sync validates both states and atomically installs one file under /data/styles. Previous files are kept in its history directory. The server reloads within 250 ms of the next profile request; no restart or cache clearing is needed.');
    return;
  }
  if (command === 'validate' && args.length === 2) return { id: (await readInput(input, stdin)).id, valid: true };
  if (command === 'sync' && args.length === 2) return syncProfile(config, await readInput(input, stdin));
  const catalog = createProfileCatalog(config);
  await catalog.refresh(true);
  if (command === 'list' && args.length === 1) return catalog.list().map(p => ({ id: p.id, name: p.name, source: p.styles ? 'file' : 'built-in', revision: p.token }));
  if (command === 'export' && args.length === 3) {
    const profile = catalog.get(input);
    if (!profile) throw new Error('Unknown profile');
    if (input === 'classic') throw new Error('Classic is protected. Export another profile as a starting point.');
    const providers = createProviders(config), cache = createStyleCache(config), styles = {};
    for (const id of ['qld', 'nsw']) styles[id] = (await cache.get(providers[id], profile)).style;
    const document = validateProfile({ format: 1, id: profile.id, name: profile.name, styles });
    if (output === '-') return document;
    await fs.writeFile(output, formatStyleJson(document), { flag: 'wx' });
    return { id: profile.id, exported: output };
  }
  throw new Error('Unknown command or arguments. Use --help.');
}
if (require.main === module) main().then(result => {
  if (result) process.stdout.write(result.format === 1 ? formatStyleJson(result) : JSON.stringify(result, null, 2) + '\n');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
