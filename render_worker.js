#!/usr/bin/env node

const maplibregl = require('@maplibre/maplibre-gl-native');
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// CLI
const args = process.argv.slice(2);
function getArg(flag){ const i=args.indexOf(flag); return i!==-1 ? args[i+1] : undefined; }
const z  = parseInt(getArg('-z'));
const x1 = parseInt(getArg('-x1'));
const x2 = parseInt(getArg('-x2'));
const y1 = parseInt(getArg('-y1'));
const y2 = parseInt(getArg('-y2'));
const outPathArg = getArg('-o');                  // optional explicit PNG path
const stylePathArg = getArg('-s') || process.env.STYLE_PATH || path.resolve(__dirname, 'styles', 'style.json');
const overwrite = args.includes('--overwrite');

if ([z,x1,x2,y1,y2].some(v => Number.isNaN(v))) {
  console.error('❌ Usage: -z Z -x1 X1 -x2 X2 -y1 Y1 -y2 Y2 [-o out.png] [-s style.json] [--overwrite]');
  process.exit(1);
}

// Directories (/data defaults)
const DATA_DIR   = process.env.DATA_DIR   || '/data';
const VECTOR_DIR = process.env.VECTOR_DIR || path.resolve(DATA_DIR, 'vector');
const RASTER_DIR = process.env.RASTER_DIR || path.resolve(DATA_DIR, 'raster');

// Tile size / ratio
const tileSize   = parseInt(getArg('--tile') || process.env.TILE_SIZE || '512');
const ratio      = parseFloat(getArg('--ratio') || process.env.RENDER_PIXEL_RATIO || '1') || 1;
const width = tileSize, height = tileSize;

// Helpers
function getTileCenter(z,x,y){
  const n=Math.pow(2,z);
  const lng=(x/n)*360-180;
  const latRad=Math.atan(Math.sinh(Math.PI*(1-(2*y)/n)));
  return [lng, (latRad*180)/Math.PI];
}
function derivePixelSize(bufLen,w,h){
  const px=bufLen/4, base=w*h;
  if (px===base) return [w,h];
  const scale=Math.sqrt(px/base);
  const W=Math.round(w*scale), H=Math.round(h*scale);
  if (W*H*4!==bufLen) throw new Error(`Pixel buffer mismatch (len=${bufLen})`);
  return [W,H];
}

// Load & force transparent background
function loadStyleTransparent(p){
  const s = JSON.parse(fs.readFileSync(p,'utf8'));
  const bg = s.layers?.find(l=>l.type==='background');
  if (!bg) s.layers = [{id:'__bg',type:'background',paint:{'background-color':'rgba(0,0,0,0)'}}, ...(s.layers||[])];
  else { bg.paint = bg.paint||{}; bg.paint['background-color']='rgba(0,0,0,0)'; }
  // Ensure glyphs is relative to /fonts handler
  if (!s.glyphs || !/fonts\/\{fontstack\}\/\{range\}\.pbf$/.test(s.glyphs)) {
    s.glyphs = 'fonts/{fontstack}/{range}.pbf';
  }
  return s;
}

async function renderOne(z,x,y){
  return new Promise((resolve)=>{
    const zStr=String(z), xStr=String(x), yStr=String(y);
    const dir = path.join(RASTER_DIR, zStr, xStr);
    const outPath = outPathArg ? path.resolve(outPathArg) : path.join(dir, `${yStr}.png`);
    if (!overwrite && fs.existsSync(outPath)) return resolve();

    let canvas = createCanvas(width, height, { alpha:true });
    let ctx = canvas.getContext('2d', { alpha:true });
    ctx.clearRect(0,0,width,height);

    const style = loadStyleTransparent(stylePathArg);

    const map = new maplibregl.Map({
      request: (req, cb) => {
        const tm = req.url.match(/\/tiles_vector\/(\d+)\/(\d+)\/(\d+)\.pbf/);
        if (tm){
          const [zS,xS,yS] = tm.slice(1);
          const pbfPath = path.join(VECTOR_DIR, zS, xS, `${yS}.pbf`);
          return fs.readFile(pbfPath, (err,data)=> cb(null, err? {} : {data}));
        }
        const fm = req.url.match(/\/fonts\/([^/]+)\/(\d+-\d+)\.pbf/);
        if (fm){
          const [fontstackRaw, range] = fm.slice(1);
          const fontstack = decodeURIComponent(fontstackRaw);
          const fontPath = path.join(__dirname, 'assets', 'fonts', fontstack, `${range}.pbf`);
          return fs.readFile(fontPath, (err,data)=> cb(null, err? {} : {data}));
        }
        cb(null,{});
      },
      ratio,
      mode:'tile',
      width,
      height
    });

    map.load(style);
    const center = getTileCenter(z,x+0.5,y+0.5);

    map.render({ zoom:z, center, width, height, bearing:0, pitch:0, buffer:256 }, (err, rgba)=>{
      if (err){ console.error(`Render error: ${z}/${x}/${y}: ${err}`); map.release(); return resolve(); }

      let W,H;
      try { [W,H] = derivePixelSize(rgba.length, width, height); }
      catch(e){ console.error(`Pixel mismatch: ${z}/${x}/${y}: ${e}`); map.release(); return resolve(); }

      let outCanvas = createCanvas(W,H,{alpha:true});
      let octx = outCanvas.getContext('2d',{alpha:true});
      let img = octx.createImageData(W,H);
      img.data.set(rgba);
      octx.putImageData(img,0,0);

      fs.mkdirSync(path.dirname(outPath),{recursive:true});
      const out = fs.createWriteStream(outPath);
      outCanvas.createPNGStream().pipe(out);
      out.on('finish', ()=>{ map.release(); resolve(); });
      out.on('error',  (e)=>{ console.error(`Write error: ${z}/${x}/${y}: ${e}`); map.release(); resolve(); });
    });
  });
}

(async ()=>{
  for (let x=x1; x<=x2; x++){
    for (let y=y1; y<=y2; y++){
      await renderOne(z,x,y);
      global.gc?.();
    }
  }
})();