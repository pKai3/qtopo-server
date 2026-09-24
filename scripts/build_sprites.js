const fs = require('node:fs/promises');
const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
async function main() {
  const style = JSON.parse(await fs.readFile('styles/style.json', 'utf8'));
  const names = [...new Set(style.layers.map(l => l.layout?.['icon-image']).filter(Boolean))].sort();
  const aliases = { 'cave': 'entrance', 'emergency-telephone': 'emergency-phone', 'college': 'college', 'harbor': 'harbor', 'town-hall': 'town-hall' };
  for (const ratio of [1, 2]) {
    const cell = 24 * ratio, canvas = createCanvas(8 * cell, Math.ceil(names.length / 8) * cell), ctx = canvas.getContext('2d'), index = {};
    for (let i = 0; i < names.length; i++) {
      const name = names[i], base = name.replace(/-\d+$/, '');
      let file = path.join('node_modules/@mapbox/maki/icons', (aliases[base] || base) + '.svg');
      try { await fs.access(file); } catch { throw new Error(`Missing Maki icon: ${base}`); }
      const x = (i % 8) * cell, y = Math.floor(i / 8) * cell;
      ctx.drawImage(await loadImage(file), x + 2 * ratio, y + 2 * ratio, 20 * ratio, 20 * ratio);
      index[name] = { x, y, width: cell, height: cell, pixelRatio: ratio };
    }
    await fs.mkdir('assets/sprites', { recursive: true });
    const file = 'assets/sprites/qld' + (ratio === 2 ? '@2x' : '');
    await fs.writeFile(file + '.png', canvas.toBuffer('image/png'));
    await fs.writeFile(file + '.json', JSON.stringify(index));
  }
  await fs.copyFile('node_modules/@mapbox/maki/LICENSE.txt', 'assets/sprites/MAKI-LICENSE.txt');
}
main().catch(err => { console.error(err); process.exit(1); });
