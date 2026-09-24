# qtopo-server

Queensland and NSW topographic maps for browsers and GPS apps. Downloads and caches vector tiles, renders PNG tiles on demand, and serves NSW's traditional topographic map sheets.

## Release channels

- `docker.io/pkai3/qtopo-server:latest` — tested QLD + NSW release.
- `docker.io/pkai3/qtopo-server:stable` — frozen pre-NSW release, preserved from the previous latest image without rebuilding it.
- `:pre-nsw` — another permanent reference to that same pre-NSW image.
- `:stable-before-nsw` — the older stable image.
- `:sha-<commit>` — individual new releases.

The pre-NSW source is tagged `pre-nsw` in GitHub. New builds publish **latest only**, after unit tests and native Linux rendering checks. The stable image is never automatically promoted.

## Unraid

Keep the existing container port **8080**, host port (for example 9878), and host folder mounted at **/data**. Updating from the existing image does not require a template change.

| Setting | Value |
|---|---|
| Repository | `pkai3/qtopo-server:latest` |
| Container port | `8080` |
| Host port | Your current port, e.g. `9878` |
| Container data path | `/data` |
| Host data path | Your existing appdata folder |
| Optional timezone | `Australia/Brisbane` |
| Optional ownership | `PUID=99`, `PGID=100` (Unraid nobody:users) |

Existing `/data/styles/style.json` edits are retained. NSW's style is seeded into `/data/styles/nsw.style.json` on first boot. New caches live in `vector/v2`, `raster/v2`, and `resources/v2`; older cache files are left in place for rollback.

If switching an existing root-owned installation to PUID/PGID, set `FIX_PERMISSIONS=1` for the first start to change ownership of the configured data directories, then remove it. Without PUID/PGID, the container retains the previous root behavior. Stop the old container before starting a replacement against the same data directory.

Open `http://<unraid-host>:<host-port>/`. Select a map and use **Copy tile URL for GPS app**. To roll back, change the Unraid repository to `pkai3/qtopo-server:stable` and update the container; the same mount and port still work.

## Maps and tile URLs

All client tile URLs use XYZ order: zoom, column, row. ArcGIS row/column ordering is handled internally.

| Map | Provider | Raster URL |
|---|---|---|
| Queensland Topographic | `qld` | `/raster/qld/{z}/{x}/{y}.png` |
| NSW Topographic vector basemap | `nsw` | `/raster/nsw/{z}/{x}/{y}.png` |
| NSW Topographic map sheets | `nsw-topo` | `/raster/nsw-topo/{z}/{x}/{y}.png` |

NSW map sheets preserve the published cartography and always output 256px PNGs (upstream JPEG tiles are converted). The vector maps allow editable styles and label sizing. The map-sheet provider caps requests at zoom 16; the viewer can overzoom those tiles.

NSW's published vector style is an overlay, so the viewer and raster output add a light background for standalone GPS use. An explicit background in your edited NSW style takes precedence. QLD retains its previous transparent-background behavior. Genuinely empty QLD raster tiles remain transparent and expire after EMPTY_TILE_TTL_MINUTES.

Existing `/raster/{z}/{x}/{y}.png`, `/vector/{z}/{x}/{y}.pbf`, and `/style.json` remain QLD aliases, regardless of DEFAULT_PROVIDER.

Additional endpoints:

- `/vector/{provider}/{z}/{x}/{y}.pbf` — QLD/NSW vector tiles.
- `/styles/{provider}.json` — MapLibre style, including sprites/fonts and attribution.
- `/api/providers` — map names, bounds, tile sizes, and URLs.
- `/?provider=nsw&mode=raster` — shareable raster preview; the URL hash preserves position.
- `/raster` and `/index_raster.html` — redirects to raster preview.
- `/healthz` — lightweight container health.
- `/readyz` — provider list and cache/renderer counters.
- `/tiles_raster/…`, `/tiles_vector/…` — legacy 308 redirects.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| PORT | 8080 | HTTP port |
| DATA_DIR | /data | Data root |
| VECTOR_DIR / RASTER_DIR / STYLE_DIR | Under DATA_DIR | Optional directory overrides |
| STYLE_PATH | /data/styles/style.json | Editable QLD style |
| FONT_DIR | Bundled fonts | Local QLD glyph directory |
| DEFAULT_PROVIDER | qld | Initial viewer map: qld, nsw, nsw-topo |
| PUBLIC_URL | Request origin | External origin, e.g. https://maps.example.com, when using an HTTPS reverse proxy |
| TILE_PX | 512 | 256 or 512 output pixels for vector-to-raster maps |
| LABEL_SCALE | 1 | Raster text/icon scale, 0.5–3; try 1.4 for a GPS app |
| VECTOR_UPSTREAM | QLD service | Optional QLD template containing {z}, {x}, {y} |
| RENDER_CONCURRENCY | 2 | Maximum simultaneous native workers |
| RENDER_QUEUE_LIMIT | 64 | Maximum queued distinct renders |
| RENDER_TIMEOUT_SECONDS | 60 | Worker deadline, maximum 300 |
| UPSTREAM_TIMEOUT_SECONDS | 20 | Download deadline, maximum 120 |
| RASTER_TTL_HOURS | 72 | Raster cache lifetime; 0 keeps successful tiles indefinitely |
| VECTOR_TTL_HOURS | 168 | Vector cache lifetime; 0 keeps successful tiles indefinitely |
| RESOURCE_TTL_HOURS | 168 | Glyph/sprite cache lifetime |
| EMPTY_TILE_TTL_MINUTES | 30 | Retry genuinely missing upstream tiles after this delay |
| CLEANUP_INTERVAL_MINUTES | 15 | Cache cleanup interval; 0 disables cleanup |
| CLEANER_INTERVAL_HOURS | — | Legacy cleanup setting, used if the minutes setting is absent |
| CLEAR_RASTER_ON_BOOT | unset | Set 1 to clear only the new v2 raster cache |
| PUID / PGID | unset | Optional runtime user/group |
| FIX_PERMISSIONS | unset | Set 1 with PUID/PGID for a one-time recursive ownership correction |

Invalid configuration fails at startup. Cache expiry is checked on access, not just by the cleanup job. Style changes and render-setting changes automatically use a new raster cache revision. Browser/GPS clients may retain an already downloaded tile for up to one hour.

A failed download or render returns an uncached 502/504 response. A full render queue returns 503 with Retry-After. Failures are never saved as successful blank tiles. Concurrent requests for the same resource are combined; providers remain isolated.

The viewer serves its JavaScript locally. Map data and uncached NSW glyphs/sprites still require internet access. Upstream resources are fetched from fixed provider URLs; this is not a general-purpose proxy.

## Development and verification

Requires Node 22+ (the container uses Node 24 LTS).

```sh
npm ci
npm test
npm run build:sprites
DATA_DIR=/tmp/qtopo node server.js
```

Native raster rendering needs the platform's graphics libraries; Linux headless operation uses Xvfb. GitHub Actions builds the amd64 Unraid image, runs native rendering checks against QLD and both NSW services at 256 and 512 pixels, and saves sample tiles as the `map-render-checks` artifact. PRs never publish latest or stable.

The live rendering checks depend on public government services. If an upstream service is down, publishing stops until the checks pass.

## Sources and credits

- [Queensland vector service](https://spatial.information.qld.gov.au/arcgis/rest/services/Hosted/Basemaps_QldBase_Topographic/VectorTileServer), © State of Queensland.
- [NSW vector basemap](https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile/VectorTileServer), © State of New South Wales (Spatial Services).
- [NSW topographic map sheets](https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Topo_Map/MapServer), © State of New South Wales (Spatial Services).
- QLD point symbols use [Maki](https://github.com/mapbox/maki); its license is included with the generated sprites. NSW uses its published symbol atlas and Public Sans glyphs.

The bundled NSW style is a snapshot of its published service style, with its source URL recorded in metadata. Existing local styles are never overwritten by an update.
