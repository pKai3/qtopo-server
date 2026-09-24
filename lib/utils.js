const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
async function cachedFile(file, ttl) {
  try {
    const st = await fs.stat(file);
    return st.isFile() && (ttl === 0 || Date.now() - st.mtimeMs < ttl) ? st : null;
  } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function httpError(message, status = 502) { return Object.assign(new Error(message), { status }); }
function imageType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  return null;
}
module.exports = { atomicWrite, cachedFile, httpError, imageType };
