const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateStyleMin } = require('@maplibre/maplibre-gl-style-spec');
const { profiles } = require('./profiles');
const { atomicWrite } = require('./utils');
const { formatStyleJson } = require('./style-format');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const reserved = new Set(['classic', 'style', 'profiles', 'raster', 'vector', 'styles', 'assets', 'fonts', 'resources', 'api', 'status', 'healthz', 'readyz', 'vendor', 'constructor', 'prototype']);
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

// Migrate the former default without replacing edits already in styles/.
// Publish through a hard link from a temporary file in the destination directory:
// readers see complete files, and a concurrent CLI cannot overwrite a winner.
async function installIfAbsent(target, data) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.migrate-${crypto.randomUUID()}`);
  await fs.writeFile(temporary, data, { flag: 'wx' });
  try {
    await fs.link(temporary, target);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally { await fs.unlink(temporary); }
}

async function migrateLegacyProfiles(config, logger = {}) {
  if (config.profileDir !== config.styleDir) return; // Honour explicit custom paths.
  const legacy = path.join(config.dataDir, 'profiles');
  if (legacy === config.profileDir) return;
  const names = await fs.readdir(legacy).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const source = path.join(legacy, name);
    try {
      const doc = await readProfile(source);
      if (name !== `${doc.id}.json`) throw new Error('Filename must match the profile name');
      const data = Buffer.from(formatStyleJson(doc)), target = path.join(config.profileDir, name);
      if (!await installIfAbsent(target, data)) {
        const current = await fs.readFile(target);
        if (JSON.stringify(JSON.parse(current)) !== JSON.stringify(doc)) {
          await installIfAbsent(path.join(config.profileDir, 'history', `legacy-${doc.id}-${digest(data)}.json`), data);
        }
      }
      await fs.unlink(source).catch(error => { if (error.code !== 'ENOENT') throw error; });
      logger.log?.('PROFILE', `Moved ${name} into styles/`);
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn?.('PROFILE', `Could not migrate ${name}: ${error.message}; original retained`);
    }
  }
  const history = path.join(legacy, 'history');
  for (const name of await fs.readdir(history).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    const source = path.join(history, name), stat = await fs.lstat(source);
    if (!stat.isFile()) continue;
    const data = await fs.readFile(source), target = path.join(config.profileDir, 'history', name);
    if (!await installIfAbsent(target, data) && !(await fs.readFile(target)).equals(data)) {
      await installIfAbsent(path.join(config.profileDir, 'history', `legacy-${digest(data)}.json`), data);
    }
    await fs.unlink(source).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  for (const directory of [history, legacy]) {
    await fs.rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  }
}

function createProfileCatalog(config, logger = {}, { interval = 250 } = {}) {
  const files = new Map();
  const bundled = profiles.map(p => ({ ...p, token: `builtin-${p.revision}` }));
  let active = new Map(bundled.map(p => [p.id, p])), pending, checked = 0, migrated = false;
  async function scan() {
    if (!migrated) { await migrateLegacyProfiles(config, logger); migrated = true; }
    const next = new Map(bundled.map(p => [p.id, p])), present = new Set();
    // A live file overrides a committed profile with the same name. Neither
    // directory is seeded or overwritten by a container update.
    const directories = [path.join(config.root, 'styles')];
    // If a filesystem permission prevented migration, still serve the valid
    // original until it can be moved, with styles/ taking precedence.
    if (config.profileDir === config.styleDir) directories.push(path.join(config.dataDir, 'profiles'));
    directories.push(config.profileDir);
    for (const directory of directories) {
      const names = await fs.readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      for (const name of names.filter(n => n.endsWith('.json') && validProfileId(n.slice(0, -5))).sort()) {
        const file = path.join(directory, name);
        present.add(file);
        const old = files.get(file);
        let stamp;
        try {
          const stat = await fs.lstat(file);
          stamp = `${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`;
          if (old?.stamp !== stamp) {
            // Plain MapLibre styles share this folder with named profiles.
            // Keep the original styles available to their provider unchanged.
            if (stat.isFile() && stat.size <= MAX_BYTES) {
              const document = JSON.parse(await fs.readFile(file, 'utf8'));
              if (!old?.profile && document.version === 8 && Array.isArray(document.layers)) continue;
            }
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
    // Keep the stored profile/cache identity so existing GPS sources and live
    // edits share exactly the same pixels through the shorter public name.
    get: id => active.get(id) || (id === 'mobile' ? active.get('mobile-3x') : undefined),
    list: () => [...active.values()],
  };
}

async function syncProfile(config, input) {
  const doc = typeof input === 'string' ? await readProfile(input) : validateProfile(input);
  await migrateLegacyProfiles(config);
  const data = formatStyleJson(doc);
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

module.exports = { validProfileId, validateProfile, readProfile, createProfileCatalog, syncProfile, migrateLegacyProfiles, MAX_BYTES };
