#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { formatStyleJson } = require('../lib/style-format');
const args = process.argv.slice(2), check = args.includes('--check');
const explicit = args.filter(arg => arg !== '--check');
const files = explicit.length ? explicit : ['styles'].flatMap(dir =>
  fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => path.join(dir, name)));
for (const file of files) {
  const original = fs.readFileSync(file, 'utf8');
  const formatted = formatStyleJson(JSON.parse(original));
  if (original === formatted) continue;
  if (check) { console.error(`Needs formatting: ${file}`); process.exitCode = 1; }
  else { fs.writeFileSync(file, formatted); console.log(`Formatted ${file}`); }
}
