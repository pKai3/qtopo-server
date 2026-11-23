// Native integration checks run in the Linux CI image, never on the local Mac.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createCanvas, loadImage } = require('canvas');
const { profiles } = require('../lib/profiles');
const origin = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const size = Number(process.env.TILE_PX || 1024);
function coordinates(lng, lat, z) {
  const n = 2 ** z;
  return `${z}/${Math.floor((lng + 180) / 360 * n)}/${Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)}.png`;
}
async function main() {
  await fs.mkdir('/tmp/smoke/profiles', { recursive: true });
  const samples = [
    { name: 'brisbane', center: [153.00782, -27.49382], z: 15, profiles },
    { name: 'swanbank-powerlines', center: [152.833, -27.658], z: 14, profiles: profiles.filter(p => ['classic', 'readable', 'mobile-3x'].includes(p.id)) },
    { name: 'nsw', center: [150.31, -33.72], z: 13, profiles },
    { name: 'lagoon', center: [152.42767, -27.45576], z: 13, profiles: profiles.filter(p => ['classic', 'readable'].includes(p.id)) },
    { name: 'clifton-road-icons', center: [151.1164, -24.2374], z: 15, profiles: profiles.filter(p => ['classic', 'readable', 'mobile-2x', 'mobile-3x'].includes(p.id)) },
    ...[13, 14, 15].map(z => ({ name: 'barney-z' + z, center: [152.6955, -28.282], z, profiles: profiles.filter(p => ['classic', 'readable', 'mobile-2x', 'mobile-3x'].includes(p.id)) })),
    { name: 'border', center: [153.539, -28.176], z: 14, profiles: profiles.filter(p => ['classic', 'mobile-3x'].includes(p.id)) },
  ];
  for (const sample of samples) {
    const contact = createCanvas(512 * sample.profiles.length, 550), ctx = contact.getContext('2d'), seen = new Set();
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, contact.width, contact.height);
    const xyz = coordinates(...sample.center, sample.z);
    for (const [index, profile] of sample.profiles.entries()) {
      const route = `/${profile.id}/${xyz}`;
      console.log('Profile smoke:', sample.name, route);
      const response = await fetch(origin + route, { signal: AbortSignal.timeout(120000) });
      assert.equal(response.status, 200, response.ok ? '' : await response.text());
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      const data = Buffer.from(await response.arrayBuffer()), image = await loadImage(data);
      assert.equal(image.width, size); assert.equal(image.height, size);
      const c = createCanvas(size, size), cc = c.getContext('2d'); cc.drawImage(image, 0, 0);
      const pixels = cc.getImageData(0, 0, size, size).data, colours = new Set();
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) colours.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      assert.ok(colours.size > 20, `${sample.name}/${profile.id} contains visible map detail`);
      seen.add(require('node:crypto').createHash('sha256').update(data).digest('hex'));
      if (profile.id === 'classic') {
        const legacy = await fetch(origin + '/raster/' + xyz);
        assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), data, 'unqualified default must still be Classic');
      }
      const cached = await fetch(origin + route);
      assert.deepEqual(Buffer.from(await cached.arrayBuffer()), data);
      await fs.writeFile(`/tmp/smoke/profiles/${sample.name}-${profile.id}.png`, data);
      ctx.drawImage(image, index * 512, 38, 512, 512);
      ctx.fillStyle = '#233b2b'; ctx.font = '17px sans-serif'; ctx.fillText(profile.name, index * 512 + 10, 25);
    }
    assert.equal(seen.size, sample.profiles.length, `${sample.name}: all appearances must produce different tiles`);
    await fs.writeFile(`/tmp/smoke/profiles/${sample.name}-comparison.png`, contact.toBuffer('image/png'));
  }
  console.log('Native profile checks passed');
}
main().catch(err => { console.error(err); process.exit(1); });
