const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateStyleMin } = require('@maplibre/maplibre-gl-style-spec');
const { profiles } = require('./profiles');
const { atomicWrite } = require('./utils');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const reserved = new Set(['classic', 'raster', 'vector', 'styles', 'assets', 'fonts', 'resources', 'api', 'status', 'healthz', 'readyz', 'vendor', 'constructor', 'prototype']);
const validProfileId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(id) && !reserved.has(id);
const MAX_BYTES = 8 * 1024 * 1024;

function validateProfile(document) {
  if (document?.format !== 1 || !validProfileId(document.id)) throw new Error('Invalid profile format or reserved name');
  if (typeof document.name !== 'string' || !document.name.trim() || document.name.length > 100) throw new Error('Profile needs a display name of 1–100 characters');
  if (!document.styles || Object.keys(document.styles).sort().join(',') !== 'nsw,qld') throw new Error('Profile must include complete qld and nsw styles');
  for (const [provider, style] of Object.entries(document.styles)) {
    const errors = validateStyleMin(style);
    if (errors.length) throw new Error(`${provider}: ${errors.slice(0, 3).map(e => e.message).join('; ')}`);
    if (!Object.keys(style.sources).length || Object.values(style.sources).some(s => s.type !== 'vector')) throw new Error(`${provider}: only provider vector sources are supported`);
    if (style.terrain) throw new Error(`${provider}: terrain is not supported in raster profiles`);
  }
  // Deliberately accept style JSON only, never scripts or external file paths.
  return { format: 1, id: document.id, name: document.name.trim(), styles: document.styles };
}

async function readProfile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Profile must be a regular JSON file smaller than 8 MiB');
  return validateProfile(JSON.parse(await fs.readFile(file, 'utf8')));
}

function createProfileCatalog(config, logger = {}, { interval = 250 } = {}) {
  const files = new Map();
  const bundled = profiles.map(p => ({ ...p, token: `builtin-${p.revision}` }));
  let active = new Map(bundled.map(p => [p.id, p])), pending, checked = 0;
  async function scan() {
    const next = new Map(bundled.map(p => [p.id, p])), present = new Set();
    // A live file overrides a committed profile with the same name. Neither
    // directory is seeded or overwritten by a container update.
    for (const directory of [path.join(config.root, 'profiles'), config.profileDir]) {
      const names = await fs.readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      for (const name of names.filter(n => n.endsWith('.json')).sort()) {
        const file = path.join(directory, name);
        present.add(file);
        const old = files.get(file);
        let stamp;
        try {
          const stat = await fs.lstat(file);
          stamp = `${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`;
          if (old?.stamp !== stamp) {
            const doc = await readProfile(file);
            if (name !== `${doc.id}.json`) throw new Error('Filename must match the profile name');
            const token = digest(JSON.stringify(doc));
            files.set(file, { stamp, profile: { ...doc, revision: 'file-v1', token } });
            logger.log?.('PROFILE', `Loaded ${doc.id} (${token.slice(0, 12)})`);
          }
        } catch (error) {
          if (old?.stamp !== stamp) logger.warn?.('PROFILE', `Rejected ${name}: ${error.message}; keeping the last valid profile`);
          files.set(file, { stamp, profile: old?.profile });
        }
        const profile = files.get(file)?.profile;
        if (profile) next.set(profile.id, profile);
      }
    }
    for (const file of files.keys()) if (!present.has(file)) files.delete(file);
    active = next;
    checked = Date.now();
  }
  return {
    async refresh(force = false) {
      if (pending) return pending;
      if (!force && Date.now() - checked < interval) return;
      pending = scan().catch(error => {
        checked = Date.now();
        logger.warn?.('PROFILE', `Could not refresh profiles: ${error.message}; keeping the last valid catalog`);
      }).finally(() => { pending = null; });
      return pending;
    },
    get: id => active.get(id),
    list: () => [...active.values()],
  };
}

async function syncProfile(config, input) {
  const doc = typeof input === 'string' ? await readProfile(input) : validateProfile(input);
  const data = JSON.stringify(doc, null, 2) + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Profile must be smaller than 8 MiB');
  await fs.mkdir(config.profileDir, { recursive: true });
  const target = path.join(config.profileDir, `${doc.id}.json`);
  const previous = await fs.readFile(target).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (previous?.equals(Buffer.from(data))) return { id: doc.id, changed: false, file: target };
  if (previous) await atomicWrite(path.join(config.profileDir, 'history', `${doc.id}-${digest(previous)}.json`), previous);
  // One atomic rename switches both states together. In-flight renders keep
  // their already-resolved style, and new requests acquire a new cache key.
  await atomicWrite(target, data);
  return { id: doc.id, changed: true, file: target, sha256: digest(data) };
}

module.exports = { validProfileId, validateProfile, readProfile, createProfileCatalog, syncProfile, MAX_BYTES };
