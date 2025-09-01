# qtopo-server

Headless **vector → raster** tile server with a built-in MapLibre **vector viewer**, automatic **on-demand PBF caching**, transparent raster output, and an **editable style** that lives on your host.

- **Viewer:** `/` (MapLibre viewer using the live style)
- **Vector tiles:** `/vector/{z}/{x}/{y}.pbf` (serve from cache or download on miss)
- **Raster tiles:** `/raster/{z}/{x}/{y}.png` (rendered via headless MapLibre worker)
- **Glyphs:** `/fonts/{fontstack}/{range}.pbf`
- **Style (editable):** `/style.json` → `/data/styles/style.json`
- **Legacy redirect:** `/tiles_raster/...` → `/raster/...` (308)

---

## Features

- **Single host mount**: `/data`
  - `/data/vector` — cached vector PBFs  
  - `/data/raster` — rendered PNG tiles  
  - `/data/styles/style.json` — **editable** MapLibre style (seeded on first boot)
- **Download-on-miss** for vector tiles with gzip detection
- **Zero-byte sentinel**: out-of-bounds PBFs cached as 0-byte → raster returns **blank.png**
- **Graceful fallbacks**:
  - **blank** tile if PBF empty  
  - **error** tile if render fails
- **Transparent PNG** output by default (background layer forced transparent)
- **Auto-cleanup** with TTL per tree (raster & vector). `0` = keep forever.
- **Viewer style hardening**: `/style.json` rewrites relative `tiles`/`glyphs` to **absolute** URLs so MapLibre workers never choke on relative paths
- **Fonts** served locally (URL-decoded fontstack)

---

## Quick Start (Docker)

```bash
docker run -d --name qtopo \
  -p 9877:8080 \
  -v /path/on/host/qtopo-data:/data \
  -e TZ="Australia/Brisbane" \
  docker.io/pkai3/qtopo-server:latest

# Open the viewer:
#   http://<host>:9877/
# Fetch a raster tile:
#   http://<host>:9877/raster/13/7551/4724.png
```
### Unraid

- **Image**: `pkai3/qtopo-server:latest` (or `:stable`)
- **Port**: container `8080` → host of your choice (e.g. `9877`)
- **Volume**: `/data` → `/mnt/user/appdata/qtopo-server`
- **Env**: configure from the table below

---

## Environment Variables

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `8080` | HTTP port inside the container |
| `DATA_DIR` | `/data` | Root of all editable/cache data |
| `VECTOR_DIR` | `$DATA_DIR/vector` | Override vector cache path |
| `RASTER_DIR` | `$DATA_DIR/raster` | Override raster output path |
| `VECTOR_UPSTREAM` | QLD service | Template for upstream PBFs (`{z}/{y}/{x}.pbf`) |
| `RASTER_TTL_HOURS` | `72` | Delete raster tiles older than N hours; `0` = never delete |
| `VECTOR_TTL_HOURS` | `0` | Delete vector tiles older than N hours; `0` = never delete |
| `CLEANUP_INTERVAL_MINUTES` | `15` | Cleanup cadence |
| `CLEAR_RASTER_ON_BOOT` | _(unset)_ | If `1`, wipe `$RASTER_DIR` at boot |
| `TILE_PX` | `256` | Output tile size for raster tiles (`256` for GPS apps; `512` for retina) |
| `LABEL_SCALE` | `1` | Multiply `text-size`/`icon-size` (and line width) during raster render |
| `TZ` | _system_ | Timezone for logs/cron-like cleanup |

> The server sets `process.umask(0o002)` so new files are group-writable. If you run on Unraid and need specific ownership, set `PUID`/`PGID` in your template and (optionally) normalize perms in `start.sh` or on boot.

---

## How Styles Work

- On first boot, the image’s baked `styles/style.json` is **seeded** to `/data/styles/style.json`.
- **All components** use the editable file:
  - Viewer: `GET /style.json` serves **/data/styles/style.json** and rewrites `tiles` & `glyphs` to **absolute** URLs.
  - Renderer: worker reads `STYLE_PATH` from the environment (set to **/data/styles/style.json** by the server).
- If the editable style is missing/unreadable, the process fails **fast**.

Edit the style at:
```
/data/styles/style.json   (on the host)
```
then refresh the viewer and re-request tiles.

---

## Endpoints

- `GET /` — static viewer (`public/index.html`)
- `GET /style.json` — active editable style (with absolute URLs)
- `GET /vector/{z}/{x}/{y}.pbf` — serve cached PBF or download, cache, and serve
- `GET /raster/{z}/{x}/{y}.png` — render & cache PNG (transparent background)
- `GET /fonts/{fontstack}/{range}.pbf` — local glyphs (URL-decoded fontstack)
- `GET /tiles_raster/{z}/{x}/{y}.png` — **308** → `/raster/{z}/{x}/{y}.png`
- `GET /healthz` — optional health endpoint (add if desired)

---

## Directory Layout

```
/usr/src/app
  ├─ server.js               # Express server & routes
  ├─ render_worker.js        # Headless raster renderer (MapLibre GL Native)
  ├─ start.sh                # Boots Xvfb + Node; logs environment
  ├─ assets/
  │   ├─ fonts/<stack>/<range>.pbf
  │   └─ images/{blank.png,error.png}
  ├─ styles/style.json       # baked style (seed source)
  └─ public/                 # viewer (index.html, regions.geojson, etc.)

/data  (bind mount)
  ├─ vector/                 # cached PBFs
  ├─ raster/                 # rendered PNG tiles
  └─ styles/style.json       # **EDIT THIS**
```

---

## Profiles (Desktop vs GPS Apps)

Many GPS apps assume **256×256** raster tiles and will downscale larger tiles, shrinking labels.

- **Desktop/retina:** `TILE_PX=512`, `LABEL_SCALE=1.0`
- **GPS apps:** `TILE_PX=256`, optionally `LABEL_SCALE=1.3–1.6`

You can run two containers (different ports) with different env sets.

---

## CI/CD & Tags

- Pushes to your trunk branch (`main`/`master`) publish **`:latest`**
- Pushes to `stable` publish **`:stable`**
- Promote by merging/fast-forwarding `stable` to the desired commit, then pull/update the Unraid container using `:stable`.

---

## Troubleshooting

**Viewer loads but vector PBFs don’t request; no server logs**  
Ensure the viewer uses **`/style.json`**. The server rewrites `tiles`/`glyphs` to **absolute** URLs so MapLibre workers in a `blob:` context don’t fail on relative paths.

**Fonts 404**  
Test directly:
```
curl -I "http://<host>:<port>/fonts/Open%20Sans%20Regular%2cArial%20Unicode%20MS%20Regular/0-255.pbf"
```
Confirm the `/fonts` route is mounted and the font folder exists under `assets/fonts/...`.

**Renderer uses baked style**  
The worker must read `STYLE_PATH=/data/styles/style.json` from env. The server exports it and passes env to `spawn`. Logs show `[WORKER] STYLE=/data/styles/style.json`.

**Transparent borders**  
Zero-byte PBFs (OOB) are cached and raster returns **blank.png** (by design).

**`spawn node ENOENT`**  
Use the provided `start.sh` (starts Xvfb, exports DISPLAY, sets PATH). Don’t call `xvfb-run` in `CMD`.

---

## Development

```bash
# Install deps
npm install

# Run locally (requires X server)
node server.js
# Or headless (Xvfb)
./start.sh
```

---

## License

None