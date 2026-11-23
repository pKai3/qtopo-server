// Native encoder verification: pixel-identical output including translucent
// antialiasing, blank tiles, text and the real QLD/NSW smoke map samples.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createCanvas, loadImage } = require('canvas');
const { encodePng } = require('../lib/png');

async function verify(canvas, name) {
  const reference = encodePng(canvas, 3, false);
  for (const level of [1, 3, 6]) {
    const fast = encodePng(canvas, level, true);
    const pixels = [];
    for (const data of [reference, fast]) {
      const image = await loadImage(data);
      assert.equal(image.width, canvas.width); assert.equal(image.height, canvas.height);
      const ctx = createCanvas(image.width, image.height).getContext('2d');
      ctx.drawImage(image, 0, 0);
      pixels.push(ctx.getImageData(0, 0, image.width, image.height).data);
    }
    assert.deepEqual(pixels[0], pixels[1], `${name}: all RGBA pixels must be identical`);
  }
}
async function main() {
  for (const size of [256, 512, 1024]) {
    const canvas = createCanvas(size, size), ctx = canvas.getContext('2d');
    await verify(canvas, 'transparent');
    ctx.fillStyle = 'rgba(110, 165, 125, 0.35)'; ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#80593d'; ctx.lineWidth = 0.8;
    for (let x = 0; x < size; x += 7) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + 40, size / 3, x - 40, size / 2, x, size); ctx.stroke(); }
    ctx.fillStyle = '#62412c'; ctx.font = '20px sans-serif'; ctx.fillText('1150', 40, 40);
    await verify(canvas, 'antialiased terrain');
  }
  for (const name of (await fs.readdir('/tmp/smoke')).filter(name => /^(qld|nsw)-.*\.png$/.test(name))) {
    const image = await loadImage('/tmp/smoke/' + name), canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    await verify(canvas, name);
  }
  console.log('PNG encoding preserves every decoded pixel');
}
main().catch(error => { console.error(error); process.exit(1); });
