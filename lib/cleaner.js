const fs = require('node:fs/promises');
const path = require('node:path');
async function prune(root, ttl, emptyTTL) {
  let deleted = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (err) { if (err.code === 'ENOENT') return; throw err; }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(file); await fs.rmdir(file).catch(err => { if (!['ENOTEMPTY', 'ENOENT'].includes(err.code)) throw err; });
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(file);
          if (e.name.endsWith('.empty')) {
            // Retain the marker for as long as its PNG exists; losing it would
            // incorrectly give an empty tile the positive-cache lifetime.
            try { await fs.access(file.slice(0, -6)); }
            catch (err) {
              if (err.code !== 'ENOENT') throw err;
              // A worker writes this marker immediately before its PNG.
              if (Date.now() - st.mtimeMs > 3600000) await fs.unlink(file);
            }
            continue;
          }
          let empty = st.size === 0;
          if (e.name.endsWith('.png')) {
            try { await fs.access(file + '.empty'); empty = true; }
            catch (err) { if (err.code !== 'ENOENT') throw err; }
          }
          const lifetime = e.name.endsWith('.tmp') ? 3600000 : empty ? emptyTTL : ttl;
          if (lifetime && Date.now() - st.mtimeMs > lifetime) {
            await fs.unlink(file); deleted++;
            if (e.name.endsWith('.png')) await fs.rm(file + '.empty', { force: true });
          }
        } catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
    }
  }
  await walk(root); return deleted;
}
function startCleaner(config, logger) {
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      const counts = [];
      for (const [root, ttl] of [[config.vectorDir, config.vectorTTL], [config.rasterDir, config.rasterTTL], [config.resourceDir, config.resourceTTL]]) counts.push(await prune(path.join(root, 'v2'), ttl, config.emptyTTL));
      logger.log('CLEANUP', `Removed vector=${counts[0]}, raster=${counts[1]}, resources=${counts[2]}`);
    } catch (err) { logger.err('CLEANUP', err.message); }
    finally { running = false; }
  }
  if (!config.cleanupInterval) return () => {};
  const timer = setInterval(run, config.cleanupInterval); timer.unref();
  return () => clearInterval(timer);
}
module.exports = { startCleaner, prune };
