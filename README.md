# qtopo-server

One XYZ tile source for Gaia GPS and other mapping apps, covering Queensland and NSW automatically. Queensland uses your editable vector style; NSW uses the official NSW vector basemap. Both are rendered into PNG tiles for the GPS client. The browser is a preview of that same tile source.

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

Keep using `http://<unraid-host>:<host-port>/raster/{z}/{x}/{y}.png` in Gaia or your existing mapping app. No provider selection is required. Open the browser preview and use **Copy QLD + NSW tile URL** when setting up a new app. To roll back, change the Unraid repository to `pkai3/qtopo-server:stable` and update the container; the same mount and port still work.

## Maps and tile URLs

Use **`/raster/{z}/{x}/{y}.png`** for the automatic QLD + NSW map, at zooms 0–19. It selects the QLD or NSW vector service by location, renders the selected vector data to PNG, and combines both renders within tiles that cross the state boundary. Output is always TILE_PX (1024 by default), with the same XYZ grid as before. Keep the tile-size setting that already works for QLD in your GPS app. The 1024px output is rendered directly from vectors at double pixel density, preserving the same geographic extent and label scale. If your container explicitly sets `TILE_PX=512`, change it to `1024` to use the higher resolution.

NSW’s published tile index selects the available vector parent at high zooms, avoiding requests for nonexistent child tiles. The renderer draws those vectors at the requested zoom. Both states render directly at the configured output resolution; the automatic route does not use scanned map sheets. QLD-only tiles reuse the existing QLD cache without changing their pixels. Previously downloaded blank NSW tiles in a GPS app may need refreshing.

All client tile URLs use XYZ order: zoom, column, row. ArcGIS row/column ordering is handled internally. The provider-specific routes below remain available for advanced use:

| Map | Provider | Raster URL |
|---|---|---|
| Queensland Topographic | `qld` | `/raster/qld/{z}/{x}/{y}.png` |
| NSW Topographic vector basemap | `nsw` | `/raster/nsw/{z}/{x}/{y}.png` |
| NSW Topographic map sheets | `nsw-topo` | `/raster/nsw-topo/{z}/{x}/{y}.png` |

NSW map sheets preserve the published cartography and always output 256px PNGs (upstream JPEG tiles are converted). The vector maps allow editable styles and label sizing. The map-sheet provider caps requests at zoom 16; the viewer can overzoom those tiles.

NSW's published vector style is an overlay, so the viewer and raster output add a light background for standalone GPS use. An explicit background in your edited NSW style takes precedence. QLD retains its previous transparent-background behavior. Genuinely empty QLD raster tiles remain transparent and expire after EMPTY_TILE_TTL_MINUTES.

The existing `/raster/{z}/{x}/{y}.png` URL now provides automatic QLD + NSW coverage. `/vector/{z}/{x}/{y}.pbf` and `/style.json` remain QLD-only interfaces; use the PNG URL for the combined GPS map.

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
| DEFAULT_PROVIDER | qld | Initial viewer location: qld, nsw, nsw-topo; automatic GPS coverage is always enabled |
| PUBLIC_URL | Request origin | External origin, e.g. https://maps.example.com, when using an HTTPS reverse proxy |
| TILE_PX | 1024 | 256, 512 or 1024 output pixels for vector-to-raster maps |
| LABEL_SCALE | 1 | Raster text/icon scale, 0.5–3; try 1.4 for a GPS app |
| VECTOR_UPSTREAM | QLD service | Optional QLD template containing {z}, {x}, {y} |
| RENDER_CONCURRENCY | 2 | Maximum simultaneous reusable native workers, 1–16 |
| RENDER_QUEUE_LIMIT | 64 | Maximum queued distinct renders |
| PREFETCH_RADIUS | 1 | Pre-render the eight adjacent tiles after requested tiles finish; 0 disables, 2 extends to 24 neighbours |
| PREFETCH_ZOOM | 1 | Pre-render one parent at z−1 and four children at z+1, after same-zoom neighbours; 0 disables zoom prefetch |
| PREFETCH_CONCURRENCY | RENDER_CONCURRENCY − 1 | Maximum simultaneous prefetch tiles, at least 1; capped to leave a render slot for requests when possible |
| PREFETCH_QUEUE_LIMIT | 64 | Maximum pending neighbouring tiles; older queued tiles are dropped when full |
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
| MESA_SHADER_CACHE_DIR | /data/resources/mesa | Compiled graphics cache shared by rendering workers; must be writable by the runtime user |

Invalid configuration fails at startup. Cache expiry is checked on access, not just by the cleanup job. Style changes and render-setting changes automatically use a new raster cache revision. Browser/GPS clients may retain an already downloaded tile for up to one hour.

A failed download or render returns an uncached 502/504 response. A full render queue returns 503 with Retry-After. Failures are never saved as successful blank tiles. Concurrent requests for the same resource are combined; providers remain isolated.

Container logs include tile requests (`REQ`), automatic state selection (`AUTO`), vector downloads and cache saves (`PBF-GET`/`PBF`), rendering and cache hits (`RDR`), and response status with elapsed time (`RES`). Transparent tiles are explicitly logged as empty. These messages appear in the Unraid container log without any extra configuration.

Rendering workers are reused between tiles, including their loaded map style and resources. Idle workers are released after two minutes and busy workers are periodically recycled. PNG compression remains lossless. `/readyz` reports configured concurrency, current and peak active renders, active renders by priority, worker starts, active upstream downloads and prefetch progress. `TIMING` logs show queue delay, worker elapsed time, time with resource requests outstanding, PNG encoding time and process CPU time. Resource waiting includes local cache reads through the server and upstream downloads; CPU time can overlap resource waiting and may include multiple native threads, so these values are not additive.

Prefetch starts after a 500ms pause with no outstanding raster requests, then fills its available worker slots without pausing between tiles. It never expands from prefetched tiles. Priority is: requested tiles, same-zoom neighbours, then zoom-out/zoom-in tiles. Within each prefetch tier, the newest requested location comes first, with nearer neighbours first within that location. Overlapping queued neighbours move to the newer request; an older request finishing late cannot jump ahead. When the queue fills, zoom tiles are discarded before same-zoom neighbours, then older/farther entries are discarded.

Zoom prefetch adds only the requested tile’s parent and four children, within the map’s zoom limits. It waits for same-zoom neighbours to finish. Requesting an already queued render promotes it instead of duplicating it. With `RENDER_CONCURRENCY=8`, prefetch can use up to seven workers by default, reserving one for incoming requests. Work already running finishes normally. `PREFETCH_CONCURRENCY` can lower background usage, and `PREFETCH_RADIUS=0` disables all prefetch. Prefetch uses the same state selection, resolution and cache as requested tiles and is logged as `PREFETCH` or `PREFETCH-Z`. Increasing concurrency uses more CPU and RAM; low CPU with active downloads can indicate workers waiting for data. 1024px tiles also require more rendering work, storage and bandwidth than 512px tiles.

The viewer serves its JavaScript locally. Map data and uncached NSW glyphs/sprites still require internet access. Upstream resources are fetched from fixed provider URLs; this is not a general-purpose proxy.

## Development and verification

Requires Node 22+ (the container uses Node 24 LTS).

```sh
npm ci
npm test
npm run build:sprites
DATA_DIR=/tmp/qtopo node server.js
```

Native raster rendering needs the platform's graphics libraries; Linux headless operation uses Xvfb. GitHub Actions builds the amd64 Unraid image, runs native rendering checks against QLD and both NSW services at 256, 512 and 1024 pixels, verifies neighbouring-tile prefetch, and saves sample tiles as the `map-render-checks` artifact. PRs never publish latest or stable.

The live rendering checks depend on public government services. If an upstream service is down, publishing stops until the checks pass.

## Sources and credits

- [Queensland vector service](https://spatial.information.qld.gov.au/arcgis/rest/services/Hosted/Basemaps_QldBase_Topographic/VectorTileServer), © State of Queensland.
- [NSW vector basemap](https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile/VectorTileServer), © State of New South Wales (Spatial Services).
- [NSW topographic map sheets](https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Topo_Map/MapServer), © State of New South Wales (Spatial Services).
- QLD point symbols use [Maki](https://github.com/mapbox/maki); its license is included with the generated sprites. NSW uses its published symbol atlas and Public Sans glyphs.

The bundled NSW style is a snapshot of its published service style, with its source URL recorded in metadata. Existing local styles are never overwritten by an update.

Automatic state selection uses the shared QLD–NSW border from the [ABS ASGS 2021 State and Territory boundary](https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/STE/MapServer/0), simplified to approximately 5 metres and rounded to six decimal places. © Australian Bureau of Statistics, CC BY 4.0. The NSW vector basemap also covers the ACT. The shared border is extended across service coverage to retain river and coastal water. It is used to combine map imagery, not as a surveyed boundary.
