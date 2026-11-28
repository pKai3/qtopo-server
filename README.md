# qtopo-server

One XYZ tile source for Gaia GPS and other mapping apps, covering Queensland and NSW automatically. Queensland uses your editable vector style; NSW uses the official NSW vector basemap. Both are rendered into PNG tiles for the GPS client. The browser supports interactive vectors and a preview of the GPS raster tile source.

## Performance benchmarks

The reusable [benchmark toolkit](scripts/benchmark/README.md) includes sequential server comparisons, saved pan patterns, live tile-request visualization, box plots and offline replay. It captures and restores the selected container’s current settings. See the guide for the read-only preflight and one-command remote launcher.

## Release channels

- `docker.io/pkai3/qtopo-server:latest` — tested QLD + NSW release.
- `docker.io/pkai3/qtopo-server:stable` — an explicitly approved, tested release, promoted from an existing commit image without rebuilding.
- `docker.io/pkai3/qtopo-server:fallback` — original pre-chat, pre-NSW image, preserved by digest without rebuilding it.
- `:sha-30852c2` — previous Stable image, retained for rollback after promotion of `cb6060f`.
- `:stable-before-15a5c79` — previous stable release through PR #12, retained for rollback.
- `:pre-nsw` — another permanent reference to that same pre-NSW image.
- `:stable-before-nsw` — the older stable image.
- `:sha-<commit>` — individual new releases.

The pre-NSW source is tagged `pre-nsw` in GitHub. New builds publish **latest only**, after unit tests and native Linux rendering checks. Latest publication verifies that Stable stays unchanged and that Fallback retains its pinned digest. The manual **Promote approved stable image** workflow takes the full tested commit SHA, verifies the image revision, and promotes its exact digest without moving Latest or Fallback.

## Unraid

For a fresh install, use the [Unraid template](unraid/qtopo-server.xml). Save it as `/boot/config/plugins/dockerMan/templates-user/my-qtopo-server.xml`, then choose `qtopo-server` from the template menu under **Docker → Add Container**. It defaults to the approved Stable image, a 4 GiB RAM limit, eight render workers, a **20 GiB maximum cache**, and **5 GiB minimum free disk space**. The two storage settings appear in the normal settings view. Change the host port or data folder if another QTopo instance already uses them. This template is stored in this repository; it is not an automatic Community Applications listing.

Keep the existing container port **8080**, host port (for example 9878), and host folder mounted at **/data**. Map delivery does not require a template change. The status page is public and read-only. Tests and cache clearing run only through the container CLI. Raw application logs remain private unless the configured networks and hostnames permit access. No second network port or extra login is required.

| Setting | Value |
|---|---|
| Repository | `pkai3/qtopo-server:stable` for the approved release; `:latest` for testing |
| Container port | `8080` |
| Host port | Your current port, e.g. `9878` |
| Container data path | `/data` |
| Host data path | Your existing appdata folder |
| Optional timezone | `Australia/Brisbane` |
| Optional ownership | `PUID=99`, `PGID=100` (Unraid nobody:users) |
| Maximum cache size | `CACHE_MAX_GIB=20` |
| Minimum free disk space | `CACHE_MIN_FREE_GIB=5` |
| Prepare NSW 2 m contours at boot | `NSW_CONTOURS_ENABLED=1` |
| Retained NSW contour packages | `NSW_CONTOURS_DIR=/data/contours/nsw` |

Existing `/data/styles/style.json` edits are retained. NSW's style is seeded into `/data/styles/nsw.style.json` on first boot. New caches live in `vector/v2`, `raster/v2`, and `resources/v2`; older cache files are left in place for rollback.

If switching an existing root-owned installation to PUID/PGID, set `FIX_PERMISSIONS=1` for the first start to change ownership of the configured data directories, then remove it. Without PUID/PGID, the container retains the previous root behavior. Stop the old container before starting a replacement against the same data directory.

Keep using `http://<unraid-host>:<host-port>/raster/{z}/{x}/{y}.png` in Gaia or your existing mapping app. No provider selection is required. Open the browser preview and use **Copy QLD + NSW tile URL** when setting up a new app. To roll back, change the Unraid repository to `pkai3/qtopo-server:stable` and update the container; the same mount and port still work.

### Status and private logs

The map includes a compact, independently collapsible **Server activity** panel with Rendering and Waiting queues, using the same requested/nearby/zoom colours as the full activity page. It remembers whether you leave it open and polls only while expanded and the page is visible.

**Find a place or coordinates** centres the map and adds a removable pin. Enter a place name and press **Find** or Enter, then choose a result. Names are looked up directly from the browser using the hosted [Photon service](https://github.com/komoot/photon#demo-server), restricted to Australia; no local place database is installed. Only submitted searches are sent, and the last 32 distinct searches are cached in memory for that page session. Photon permits modest use but does not guarantee availability. Coordinate pairs are parsed entirely in the browser, without a lookup: use latitude then longitude, such as `-28.28, 152.70`, or hemisphere notation such as `28°16′48″S 152°42′00″E`. Search keeps the current appearance and map mode; automatic state selection continues to follow the map centre.

Open `/status` on the normal server URL for public, read-only activity charts. `/readyz` returns aggregate counters, settings and readiness; it omits individual tile locations, test coordinates and local maintenance details. It returns HTTP 503 with an explanation when storage checks fail, disk limits cannot be met, memory admission cannot read its limit, requested work stalls, or three consecutive renders or provider downloads fail. The dashboard continues showing live figures and the reason while degraded. Actual successful renders/downloads clear their corresponding failure state. An idle server starts ready; no extra map downloads or renders are scheduled just to check health. `/healthz` remains the lightweight process liveness check used by Docker, so an upstream outage does not itself cause restart loops. Readiness transitions are also logged. Enabling ZeroTier is not required to view status. The former `/api/actions/*` web endpoints return 404 for every client, including localhost and trusted proxies.

Raw logs contain requested tile locations and remain restricted. The log panel is shown only to allowed clients:

- `ADMIN_ALLOWED_NETWORKS`: verified client addresses/CIDRs for private log access; empty disables web log access.
- `ADMIN_ALLOWED_HOSTS`: exact names/IPs used for private logs, without schemes or ports.
- `TRUSTED_PROXIES`: only the proxy's actual source address as seen by QTopo. This also allows correctly forwarded HTTPS URLs. Never trust an entire Docker/LAN network as a proxy.

A public DNS name still uses its public route when ZeroTier is enabled. That affects private logs; status, tile previews and map tiles are public. Read full container logs from Unraid or `docker logs` when needed. Forwarded private addresses from untrusted peers cannot enable log access.

The public status page's **Tile flyby** switch shows a sample of freshly rendered
tiles drifting up the right edge. It is off by default and remembers the browser's
choice. The preview feed is public and contains map images, zoom, style and render
priority, without client identifiers or tile coordinates. Raw logs remain private.
Hidden pages stop watching, and reduced-motion
settings use still cards. The existing renderer creates a 160px JPEG after saving
the requested PNG, sampling at most four jobs per second across all viewers. There are
no extra map renders or tile downloads. Sampling stops within three seconds of the
last viewer disconnecting; history is bounded to 32 small images for 15 seconds.

## Maps and tile URLs

Use **`/raster/{z}/{x}/{y}.png`** for the automatic QLD + NSW map, at zooms 0–18. Set the GPS source’s maximum zoom to 18; the browser uses the same limit. The server selects the QLD or NSW vector service by location, renders the selected vector data to PNG, and combines both renders within tiles that cross the state boundary. Output is always TILE_PX (1024 by default), with the same XYZ grid as before. Keep the tile-size setting that already works for QLD in your GPS app. The 1024px output is rendered directly from vectors at double pixel density, preserving the same geographic extent and label scale. If your container explicitly sets `TILE_PX=512`, change it to `1024` to use the higher resolution.

NSW’s published tile index selects the available vector parent at high zooms, avoiding requests for nonexistent child tiles. The renderer draws those vectors at the requested zoom. Both states render directly at the configured output resolution; the automatic route does not use scanned map sheets. QLD-only tiles reuse the existing QLD cache without changing their pixels. Previously downloaded blank NSW tiles in a GPS app may need refreshing.

### Appearance profiles

The unqualified `/{z}/{x}/{y}.png` and `/raster/{z}/{x}/{y}.png` URLs follow `DEFAULT_PROFILE`, initially `readable`. Choose an **Appearance** in the viewer and use **Copy QLD + NSW tile URL** to add that profile as a separate Gaia source.

| URL path | Appearance |
|---|---|
| `/classic/{z}/{x}/{y}.png` | Existing colours, symbols and desktop sizing |
| `/readable/{z}/{x}/{y}.png` | Revised colours, water masking and icon-label placement, with prepared NSW 2 m contours when available |
| `/mobile/{z}/{x}/{y}.png` | Mobile sizing (formerly Mobile 3×) |
| `/nsw-2m/{z}/{x}/{y}.png` | Readable with official NSW 2 m derived contours; available after preparation |

`/mobile-3x/{z}/{x}/{y}.png` remains an alias to Mobile, using the same live style and rendered cache. Mobile 2× and the original enlarged variants are retired from the viewer choices; existing URLs remain compatible. Open `/classic` for the Classic viewer. Readable is the default on `/`.

These names always select the current recipe; no version suffix is required. QLD/NSW selection remains automatic. The PNG dimensions and XYZ geography stay the same. Readable and the NSW 2 m profile use the independent prepared contour source once available; other profiles retain their existing sources. Source data, fonts and sprites are shared; prepared styles, rendered tiles and prefetch groups are isolated by profile. Classic retains the previous cache revision exactly. Saved style files are never overwritten. Recipe changes get fresh server cache revisions without clearing any existing cache; Gaia's own saved/offline tiles still require a refresh or download to see changes.

Readable and Mobile use softer land/contour colours and stronger text halos. Power lines are thin grey dashes at every display scale. In QLD, opaque water polygons cover waterway skeleton lines inside permanent water bodies while keeping external creek segments and drawing shorelines, roads and bridges above them. QLD point symbols that previously centred icon and text together let their label choose a clear side; the icon remains at its actual location. Existing custom label offsets are respected. NSW uses its own published ordering and collision rules, with larger features and revised water/contour colours. Pre-rendered NSW map sheets cannot be restyled.

Advanced clients can request `/raster/{profile}/{provider}/{z}/{x}/{y}.png` or `/styles/{profile}/{provider}.json`. Legacy provider-specific routes follow the configured default. `/api/providers` lists profiles, aliases, retired-choice visibility and absolute tile templates; `/?profile=mobile&mode=raster` opens the Mobile preview.

### Retained NSW 2 m contours

Startup automatically downloads and prepares the complete official NSW derived contour catalogue in the background. The current catalogue contains **343 sheets and 29.2 GB (27.2 GiB) of compressed source archives**. Allow additional space for prepared per-sheet tiles, the assembled map and temporary processing files. The normal map stays usable throughout preparation. Set `NSW_CONTOURS_ENABLED=0` to disable this feature, including its download.

All source packages and prepared tiles remain under `NSW_CONTOURS_DIR`, normally `/data/contours/nsw` on the persistent data mount. This is retained map data, separate from the disposable **20 GiB cache**. It is never removed by cache expiry, the cache-clearing command or a container restart. Keep this directory outside `vector`, `raster` and `resources`; a separate disk can be mounted here if desired. The importer respects `CACHE_MIN_FREE_GIB` (5 GiB by default) on its own filesystem, reserves working space before preparing a sheet, and waits when space is insufficient. It does not delete source packages to free space.

Interrupted downloads resume with checked byte ranges and pinned source versions. Complete archives receive CRC and SHA-256 checks. Each prepared sheet is saved before moving to the next; a restart reuses completed work. Preparation runs one sheet at a time with eight processing threads by default and reduced CPU priority. Temporary network failures or insufficient space retry automatically after 60 seconds. Container logs report stage changes and a `[CONTOURS]` progress line every 30 seconds while preparation is running, including downloaded GB, prepared sheets, the current sheet and time since startup. `/api/contours` and the compact line beneath **Appearance** also report public progress.

Final assembly reports input databases checked, input tiles processed, recent processing speed, output GB and separate validation/checksum/publication stages. After 30 seconds of measured progress, logs estimate the remaining time for the current merge or checksum stage using the recent two-minute window; later stages are not included. Estimates disappear if processing stalls. The map's compact status line shows assembly progress instead of repeating that all source sheets are prepared. A small opt-in patch to the pinned `tile-join` adds these counters without changing generated map data or invalidating retained sheets.

Once every sheet is prepared, one complete tile set is published atomically. **Readable**, the default appearance, automatically replaces NSW's original contour strokes and labels with this dataset in both the browser and normal GPS tile URLs. Until then, or when preparation is disabled, Readable uses the original NSW contours. The viewer refreshes the selected appearance in place when publication is detected; its camera and layer choices are preserved. New server-rendered tiles receive a new cache identity, while QLD's rendered cache is reused. Later updates continue serving the previous complete dataset until the replacement is ready.

**NSW · 2 m contours** also appears in Appearance as an explicit choice, with `/nsw-2m/{z}/{x}/{y}.png` retained for existing clients and separate style customization. Explicit requests for that profile return a retryable 503 while unavailable. If configured as `DEFAULT_PROFILE`, unqualified URLs use Readable until preparation finishes.

The profile follows the current Readable base, including live edits, and replaces NSW's original contour strokes and labels while retaining other map detail. QLD retains Readable's appearance. An explicit `nsw-2m` profile file takes precedence over that inherited base. Contour intervals shown are 50 m from zoom 10, 10 m from zoom 12, and 2 m from zoom 15. Prepared vector tiles extend through zoom 16 and retain their detail when zoomed further in, independently of the older NSW basemap's coverage. Both the browser map and native PNG renderer use these same tiles. No source conversion or contour generation runs in a map request.

These are the official **2 m vertical-interval contours**, derived from a 5 m elevation grid with mixed LiDAR and photogrammetric inputs; the interval does not imply a 2 m terrain grid or uniform vertical accuracy. The pinned source catalogue, bounds, sizes, source versions and attribution are in `assets/nsw-contours-catalog.json`. Retained publication manifests record source checksums and the preparation recipe. The Docker image includes GDAL and the checksum-pinned Tippecanoe 2.78.0 toolchain; native development needs `python3`, `ogr2ogr`, `tippecanoe` and `tile-join` on PATH. Changes to the preparation algorithm or pinned tiler must also advance the importer's recipe version.

### Live profile updates

After installing the server release that supports live profiles, styles can be updated through SSH without another image build or container restart. Export a complete profile, edit its QLD and NSW style JSON, then sync it back:

```sh
ssh root@your-server 'docker exec qtopo-server-latest node scripts/profiles.js export mobile-3x -' > mobile-3x.json
# Edit mobile-3x.json, then validate and install it atomically:
ssh root@your-server 'docker exec -i qtopo-server-latest node scripts/profiles.js sync -' < mobile-3x.json
```

Use `docker exec -u <PUID>:<PGID>` when the container runs as a configured Unraid user. The CLI also accepts ordinary file paths and has `list` and `validate` commands. The JSON's `id` determines the URL: keeping `mobile-3x` updates that existing source; changing it to a new name creates another source. Classic is protected from file overrides, and syncing does not change `DEFAULT_PROFILE`.

One file contains both state styles. Sync validates it before installation and keeps the previous file under `/data/styles/history`. Sync a history file to roll back. New requests detect changes within 250 ms; in-flight requests finish with their captured style. Only changed styles get new raster cache identities, and old tiles remain available for rollback. Live profiles use immediate HTTP revalidation, but Gaia's downloaded/offline tiles may still need refreshing in the app. Invalid file edits keep the last valid in-memory profile; always use the CLI to avoid leaving invalid data on disk across a restart.

Exporting `readable` or `nsw-2m` saves its editable base styles, without generated contour sources or fixed dataset URLs. Keep that profile ID when syncing: the server adds the current completed contour dataset at render time. Export and editing also work before the download finishes.

Live files in `/data/styles` override committed defaults in the image's `styles/` directory. The original provider styles and named profiles share this folder. Upgrading automatically moves files and history from the former `/data/profiles` default, preserving newer files already in `styles/` and archiving conflicting older copies. Explicit custom `PROFILE_DIR` settings are honoured. To include an approved profile in a later release, export it, validate it and commit it as `styles/<id>.json`. Image updates never overwrite live files. To resume following the bundled profile, move the corresponding live JSON out of `/data/styles` after saving a copy.

Style exports, syncing and generation use indented JSON with one layer per row and aligned short columns. Run `node scripts/format-styles.js` to apply the same layout to existing files. Live cartography is versioned on `codex/live-styles`, whose pushes do not publish Docker images.

Profile files contain complete MapLibre styles, including layer filters and zoom thresholds. Provider tile URLs are normalized to the server's existing proxies. QLD uses the bundled symbols by default; setting `styles.qld.sprite` to `/resources/qld/sprites/sprite` selects official QTopo symbols and fonts through the existing resource proxy. Match `icon-image` names and font stacks to that resource set. NSW retains its official symbols. There is no HTTP upload or editing endpoint.

All client tile URLs use XYZ order: zoom, column, row. ArcGIS row/column ordering is handled internally. The provider-specific routes below remain available for advanced use:

| Map | Provider | Raster URL |
|---|---|---|
| Queensland Topographic | `qld` | `/raster/qld/{z}/{x}/{y}.png` |
| NSW Topographic vector basemap | `nsw` | `/raster/nsw/{z}/{x}/{y}.png` |
| NSW Topographic map sheets | `nsw-topo` | `/raster/nsw-topo/{z}/{x}/{y}.png` |

NSW map sheets preserve the published cartography and always output 256px PNGs (upstream JPEG tiles are converted). The vector maps allow editable styles and label sizing. The map-sheet provider caps requests at zoom 16; the viewer can overzoom those tiles.

NSW's published vector style is an overlay, so the viewer and raster output add a light background for standalone GPS use. An explicit background in your edited NSW style takes precedence. QLD retains its previous transparent-background behavior. Genuinely empty QLD raster tiles remain transparent and expire after EMPTY_TILE_TTL_MINUTES.

The existing `/raster/{z}/{x}/{y}.png` URL now provides automatic QLD + NSW coverage. `/vector/{z}/{x}/{y}.pbf` and `/style.json` remain QLD-only interfaces; use the PNG URL for the combined GPS map.

The shorter `/{z}/{x}/{y}.png` URL is an alias for the same automatic raster source and shares its cache. For example, an HTTPS proxy can expose `https://topo.example.com/{z}/{x}/{y}.png`.

Public map endpoints send CORS headers so Gaia and other browser clients can fetch tiles directly without a CORS proxy. Raw application logs require explicitly allowed client networks and hostnames. Web maintenance actions do not exist; CORS restrictions alone are not access control. Gaia's HTTPS website may still block an HTTP tile URL as mixed content: keep its **Route Through CORS Proxy** option enabled for that URL, or use an HTTPS reverse proxy for direct access. Leave **Reversed Y Coordinate** off; this server uses XYZ coordinates.

In the browser, **Automatic + Interactive vector map** loads PBF tiles and renders them on your device. The map centre selects the QLD or NSW style using the same state boundary as the server. Panning across the border switches the displayed state after the pan, retaining the camera and layer preferences. This vector preview shows one state's style at a time; **Raster tiles / GPS preview** shows the combined, border-clipped PNGs used by Gaia. NSW map sheets are always raster and the URL and selector reflect that. The on-screen caption identifies the active vector state or raster tile resolution.

Additional endpoints:

- `/vector/{provider}/{z}/{x}/{y}.pbf` — QLD/NSW vector tiles.
- `/styles/{provider}.json` — MapLibre style, including sprites/fonts and attribution.
- `/api/providers` — map names, bounds, tile sizes, and URLs.
- `/?provider=nsw&mode=raster` — shareable raster preview; the URL hash preserves position.
- `/raster` and `/index_raster.html` — redirects to raster preview.
- `/healthz` — lightweight container health.
- `/readyz` — public read-only status: provider list and aggregate cache/renderer counters.
- `/status` — public read-only activity page; raw logs are shown only for allowed private clients.
- `/api/logs` — restricted management log: the most recent 500 entries, with incremental cursors; memory only, reset on restart.
- `/tiles_raster/…`, `/tiles_vector/…` — legacy 308 redirects.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| PORT | 8080 | HTTP port |
| ADMIN_ALLOWED_NETWORKS | empty (web logs disabled) | Comma-separated client IP addresses/CIDRs allowed to read raw logs; use only your verified LAN/ZeroTier networks |
| ADMIN_ALLOWED_HOSTS | localhost,127.0.0.1,[::1] | Exact hostnames/IPs allowed for private log access, without schemes or ports; also prevents DNS rebinding |
| TRUSTED_PROXIES | empty (none trusted) | Exact reverse-proxy IPs/CIDRs allowed to supply client addresses and HTTPS forwarding headers; never use the whole Docker or LAN subnet |
| DATA_DIR | /data | Data root |
| VECTOR_DIR / RASTER_DIR / STYLE_DIR | Under DATA_DIR | Optional directory overrides |
| STYLE_PATH | /data/styles/style.json | Editable QLD style |
| PROFILE_DIR | STYLE_DIR (/data/styles) | Validated live profile JSON files; persistent overrides of bundled profiles |
| FONT_DIR | Bundled fonts | Local QLD glyph directory |
| NSW_CONTOURS_ENABLED | 1 | Download and prepare the retained official NSW 2 m catalogue at boot; 0 disables it and its profile |
| NSW_CONTOURS_DIR | /data/contours/nsw | Persistent source archives and prepared contour tiles, outside the disposable cache directories |
| NSW_CONTOURS_THREADS | 8 | Background processing threads, 1–8; map sheets are prepared sequentially |
| NSW_CONTOURS_RETRY_SECONDS | 60 | Retry interval after preparation failure or insufficient free disk space, 5–3600 seconds |
| DEFAULT_PROFILE | readable | Appearance for unqualified raster/style URLs; a built-in or installed profile name. Named URLs remain independent of this choice. |
| DEFAULT_PROVIDER | qld | Initial viewer location: qld, nsw, nsw-topo; automatic GPS coverage is always enabled |
| PUBLIC_URL | Request origin | External origin, e.g. https://maps.example.com, when using an HTTPS reverse proxy |
| TILE_PX | 1024 | 256, 512 or 1024 output pixels for vector-to-raster maps |
| METATILE_SIZE | 2 | Render a fixed 2×2 vector grid together; set 1 for single-tile rendering. PNG dimensions and URLs stay the same. |
| RENDER_BUFFER_PX | 64 | Border around the render area, in logical pixels at 512px per tile (128 output pixels at TILE_PX=1024). Even values 0–256; cropped before saving. Set 0 with METATILE_SIZE=1 to use the previous unpadded renderer. |
| PNG_COMPRESSION_LEVEL | 3 | Lossless PNG compression, 0–9. Try 6 for slightly smaller files at the cost of more encoding CPU; resolution and colours are unchanged. Applies to newly rendered tiles only. |
| LABEL_SCALE | 1 | Legacy extra raster text/icon multiplier, 0.5–3, applied on top of every profile; keep 1 when comparing named profiles. |
| VECTOR_UPSTREAM | QLD service | Optional QLD template containing {z}, {x}, {y} |
| RENDER_CONCURRENCY | 8 | Maximum simultaneous reusable native workers, 1–24. With a Docker memory cap, actual concurrency adapts to available memory. |
| RENDER_MEMORY_GUARD | 1 | Adapt concurrency and release speculative work when approaching the Docker RAM cap. Set 0 for unguarded admission; Docker still enforces its hard memory limit and worker recycling remains enabled. |
| RENDER_MEMORY_HEADROOM_MB | 512 | Minimum memory headroom in MiB (0–65536). The guard reserves the larger of this value and the percentage below. |
| RENDER_MEMORY_HEADROOM_PERCENT | 12.5 | Proportional memory headroom, 0–50 percent of the Docker RAM cap. Applies while the guard is enabled. |
| RENDER_MEMORY_INITIAL_WORKER_MB | 512 | Initial reservation for an unmeasured worker workload, 128–4096 MiB. Measured peaks refine it after enough renders. |
| RENDER_WORKER_MAX_RSS_MB | 384 | Replace a worker after its completed render if resident memory reaches this many MiB (64–4096). The old process exits before its slot is reused. This bounds retention between jobs, not peak memory during a single render; keep a Docker RAM limit as well. |
| LP_NUM_THREADS | 1 (Docker) | Mesa software-rendering threads per worker. Independent of `RENDER_CONCURRENCY`; avoids multiplying each worker by the host CPU count. |
| MALLOC_ARENA_MAX | 2 (Docker) | Limit glibc allocator arenas per process to reduce retained native memory. |
| MALLOC_MMAP_THRESHOLD_ | 131072 (Docker) | Allocate large native buffers separately so freeing them can return their memory to the OS. Bytes; explicit setting prevents the threshold growing with repeated renders. |
| MALLOC_TRIM_THRESHOLD_ | 131072 (Docker) | Keep glibc's heap-trimming threshold fixed so releasable heap memory is returned between renders. Bytes. |
| RENDER_QUEUE_LIMIT | 64 | Maximum queued distinct renders |
| REQUEST_PAN_THRESHOLD | 8 | Tile distance from the current area anchor before a pan moves queued requests to a new area; positive integer, measured in either axis at the requested zoom |
| REQUEST_REPRIORITIZE | 1 | Prefer each client IP's current area and zoom within a priority tier. Set 0 to keep requested jobs in arrival order across pans/zooms, including for devices sharing an IP. Requested tiles still take priority over prefetch. |
| PREFETCH_PREEMPT | 1 | Allow requested tiles to interrupt active speculative renders when capacity is unavailable. Set 0 to let them finish; the enabled memory guard can still release speculative work under memory pressure. |
| PREFETCH_RADIUS | 1 | Nearby tile radius, 0–10; 0 disables prefetch. Radius 1 considers 8 neighbours, 2 considers 24, and 10 considers 440. The queue limit bounds retained work, favouring the nearest tiles around recent requests |
| PREFETCH_ZOOM | 1 | Pre-render one parent at z−1 and four children at z+1, after same-zoom neighbours; 0 disables zoom prefetch |
| PREFETCH_CONCURRENCY | RENDER_CONCURRENCY − 1 | Maximum simultaneous prefetch groups, at least 1; QLD vector siblings share a grid group, while other tile types count individually. The render queue also caps background jobs to leave a slot for requests when possible. |
| PREFETCH_QUEUE_LIMIT | 64 | Maximum pending neighbouring tiles; older queued tiles are dropped when full |
| RENDER_TIMEOUT_SECONDS | 60 | Worker deadline, maximum 300 |
| REQUEST_TIMEOUT_SECONDS | 120 | Total tile-request deadline, including discovery, queue/memory waiting and delivery; 1–900 seconds. A timeout returns an uncached, retryable 504 if delivery has not started. |
| UPSTREAM_TIMEOUT_SECONDS | 20 | Download deadline, maximum 120 |
| CACHE_MAX_GIB | 20 | Maximum combined managed cache size across vector/v2, raster/v2 and resources/v2. Oldest unused files are removed when exceeded. 0 disables this limit. |
| CACHE_MIN_FREE_GIB | 5 | Minimum free space on each filesystem containing a managed cache. Cleanup can run even below the maximum cache size. 0 disables this limit. |
| CACHE_CHECK_INTERVAL_SECONDS | 30 | Free-space check interval; 1–3600 seconds. Completed writes also trigger a cache-size check when needed. |
| UPSTREAM_CONCURRENCY | 16 | Maximum concurrent upstream downloads, 1–64; prefetch may use up to half, leaving capacity for requested resources when possible |
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

Invalid configuration fails at startup. Cache expiry is checked on access, not just by the cleanup job. Style changes and render-setting changes automatically use a new raster cache revision. HTTP responses advertise up to one hour of freshness; Gaia's saved/offline maps can retain old tiles until explicitly refreshed or downloaded again.

Storage cleanup removes expired files first, then the oldest unused managed cache files when either limit is exceeded. It aims for 90% of the cache-size limit and 110% of the minimum free-space threshold, stopping only when both constraints are satisfied or no eligible files remain. Each cache filesystem is checked separately. The dashboard shows estimated cache size, free space, reclaimed bytes and the last full scan. Writes update the estimate; full scans reconcile it. These are cleanup thresholds, so concurrent writes can temporarily exceed them.

Cached files being read, sent or written are protected, including sibling outputs and source images of active renders. A request arriving during eviction waits for deletion to finish and then follows the ordinary cache-miss path. PNGs and their empty markers are managed together. Cleanup stays within the three managed `v2` cache trees; it preserves styles, profile history, legacy rollback caches, shader data, unrelated files and symlink targets. If other data or active files prevent enough space being reclaimed, readiness reports the unresolved pressure. The normal expiry interval remains independent; setting it to zero does not disable disk limits.

Each live HTTP tile request owns a separate subscription to shared render work. One disconnect or deadline does not cancel another request for the same tile or a sibling in its metatile, even when they share an IP address. Only a queued job with no remaining subscribers and no prefetch commitment is removed; already running renders finish under their existing worker deadline. An immediate retry starts or joins valid work rather than a cancelled job. Panning changes priority, not whether an open request is still wanted. If a request deadline expires after streaming has begun, the connection closes rather than presenting a partial PNG as a complete tile.

Parsed styles and their cache revisions are reused in memory. File metadata is checked on every access so local style edits still take effect immediately. NSW zoom variants are cached separately without altering the base style. The metatile renderer uses a new vector raster revision so old clipped images are regenerated; vector downloads and other resource caches are reused. Successful cached delivery avoids a second PNG/empty-marker lookup. Expired tiles still refresh before delivery; stale tiles are not served while refreshing in the background. Changing PNG compression does not invalidate existing tiles because their pixels are unchanged.

Vector rendering places labels across a fixed 2×2 grid plus a border before cropping four normal tiles. This keeps labels consistent across the grid's internal seams and reduces clipping at its outer edges; independently rendered grids can still make different collision decisions. The temporary larger image stays in memory. Only the usual PNG tiles are saved, with requested tiles encoded and released first. Requests for the same grid/style share one job and can promote an active prefetch job. Each worker uses more memory and the first uncached tile can take longer, while neighbouring tiles share the work. One job produces up to four tiles even when optional prefetch is disabled. NSW tiles with different source zoom limits use separate style jobs to preserve their detail. Raster map sheets and state-border compositing remain individual-tile operations.

A failed download or render returns an uncached 502/504 response. A full render queue returns 503 with Retry-After. Failures are never saved as successful blank tiles. Concurrent requests for the same resource are combined; providers remain isolated.

The container starts its own virtual display (Xvfb), choosing a free display number and verifying a real connection before starting the HTTP server. `DISPLAY` is managed internally. A dead display stops the container immediately with a nonzero exit code. A running display must fail three consecutive connection checks before shutdown, allowing a brief stall to recover. Checks run after a two-second pause, time out after three seconds, and force termination of a stuck probe after one additional second. Startup still requires a successful first check. A configured Docker restart policy can recover the service after shutdown; existing tile caches are retained. Display messages use `[DISPLAY]` in the Unraid container log and distinguish process exits, probe errors, timeouts and recovery, including exit status and available error output.

Container logs include tile requests (`REQ`), automatic state selection (`AUTO`), vector downloads and cache saves (`PBF-GET`/`PBF`), rendering and cache hits (`RDR`), and response status with elapsed time (`RES`). Transparent tiles are explicitly logged as empty. These messages appear in the Unraid container log without any extra configuration. Native renderer stdout/stderr is forwarded as `NATIVE` with the worker PID, so crash details also appear in the status-page application log. Xvfb and other container-level output remains available in Unraid.

Rendering workers are reused between tiles, including their loaded map style and resources. Idle workers are released after two minutes and busy workers are periodically recycled. PNG compression remains lossless. `/readyz` reports configured concurrency, current and peak active renders, active renders by priority, worker starts, active upstream downloads and prefetch progress. `TIMING` logs show queue delay, worker elapsed time, time with resource requests outstanding, PNG encoding time and process CPU time. Resource waiting includes local cache reads through the server and upstream downloads; CPU time can overlap resource waiting and may include multiple native threads, so these values are not additive.

When a finite Linux cgroup memory limit is present, render admission reads the whole container's working memory (including the server and idle workers, excluding reclaimable inactive file cache). It leaves 12.5% of the cap, at least 512 MiB, as headroom. Each new style/zoom/size class initially reserves at least 512 MiB (or a larger recent observed peak); after four completed renders in that class it uses the largest of its last 32 anonymous resident peaks, with a 128 MiB minimum. Dense zoom-prefetch peaks therefore do not set every foreground reservation. The shared headroom covers growth beyond those observations, without adding a second percentage margin to every worker. Shared file/library pages are counted by the container working set, rather than reserved repeatedly for each worker. Per-render peaks reset for each job; a process lifetime high-water mark is not reused for later smaller jobs. Reservations include jobs admitted before their processes start and expected growth in running workers. Pending jobs credit distinct warm idle workers whose retained allocations are already included in the container usage. Memory is sampled every 100ms and reread before admission. A failed reading pauses new renders until it recovers. Prefetch reserves room for an incoming requested render against both CPU slots and the effective memory budget; cached tiles bypass the gate. A blocked request can interrupt speculative renders, starting with zoom prefetch, and waits for their processes to exit before reusing the memory. Renders serving a real client are never interrupted. Under memory pressure, speculative work can also be released without waiting for a new request. Spare idle native maps are released one at a time when necessary, preserving warm reuse where possible. No configured CPU, RAM or worker setting is rewritten.

`/readyz` exposes `renderer.memory` with current/peak working usage, current/peak total cgroup charges, worker reservation size, pause count, parent/worker/idle RSS, worker anonymous resident memory, and released idle workers. The status page shows **Memory limited** while queued work waits for room. Per-process RSS can double-count shared pages; the cgroup working set drives admission. This is a measured admission estimate, not a hard per-job memory guarantee: unusually large single renders can exceed previous peaks. Keep Docker's hard limit. Repeated pan tests exercise 24 configured workers with a 4 GiB cap, multiple styles/zooms and prefetch, record a memory history, and check that all work drains without an OOM or restart.

Prefetch starts after a 500ms delay at the beginning of a new burst, then prepares same-zoom neighbours using spare rendering capacity even while other raster requests remain outstanding. Continuing requests do not keep resetting that initial delay. The render queue always selects waiting requested tiles first and reserves a foreground slot when possible. It never expands from prefetched tiles. Priority is: requested tiles, same-zoom neighbours, then zoom-out/zoom-in tiles. Within each prefetch tier, the newest requested location comes first, with nearer neighbours first within that location. Overlapping queued neighbours move to the newer request; an older request finishing late cannot jump ahead. When the queue fills, zoom tiles are discarded before same-zoom neighbours, then older/farther entries are discarded.

Queued work follows each client IP's latest requested zoom and area. Within each priority tier, tiles near that area's anchor at the latest zoom come first, followed by other tiles at that zoom, then older zooms. A zoom change updates the anchor immediately; a pan moves it when a request is more than `REQUEST_PAN_THRESHOLD` tiles away horizontally or vertically. Already queued tiles are re-evaluated when a worker becomes available, including when zooming back to an earlier level. Equally relevant requested jobs keep arrival order. Older jobs remain queued subject to the existing queue limits, and running requested jobs finish normally. Shared renders retain the best priority among the clients requesting their tiles. Focus follows request arrival even on cache hits, so an old render finishing late cannot move it back.

Focus tracking uses the client address supplied by Express's existing exact proxy trust configuration. It retains at most 256 client entries in memory and expires them after one minute without requests; IPs and focus coordinates are not added to public status. Clients sharing an IP share one inferred focus, and interleaved zoom requests can move it back and forth because standard XYZ requests do not describe the client's viewport. Normal interrupted downloads remain counted as client disconnects; confirmed closed-connection errors do not produce duplicate HTTP error stacks.

Zoom prefetch adds only the requested tile’s parent and four children, within the map’s zoom limits and never above zoom 18. Same-zoom neighbour prefetch obeys the same limit, including when a legacy client explicitly requests a higher tile. Queued requests and same-zoom neighbours take priority; zoom work can use spare background capacity while those earlier jobs are still running. Requesting an already queued or running prefetch render reclassifies it as requested, sharing the existing work. The status charts count render jobs (up to four vector tiles each), not HTTP requests: cached PNG responses bypass the workers and appear in the session and cache counters. With `RENDER_CONCURRENCY=8`, prefetch can use up to seven workers by default, reserving one for incoming requests. The reserved slot also reserves memory, so background work cannot silently consume it when RAM limits usable concurrency. Requested tiles can interrupt running speculative work if necessary; running requested jobs remain protected. A new neighbour may still wait for running zoom work. `PREFETCH_CONCURRENCY` can lower background usage, and `PREFETCH_RADIUS=0` disables all prefetch. Prefetch uses the same state selection, resolution and cache as requested tiles and is logged as `PREFETCH` or `PREFETCH-Z`. Increasing concurrency uses more CPU and RAM; low CPU with active downloads can indicate workers waiting for data. 1024px tiles also require more rendering work, storage and bandwidth than 512px tiles.

QLD vector prefetch groups sibling tiles by their metatile grid, including automatic tiles wholly inside QLD. Waiting for several outputs from one grid no longer consumes several prefetch group slots. Each tile still checks its own output; group membership never assumes another tile was saved. NSW style variants, border composites and raster providers remain individually counted. `/readyz` reports both active prefetch tiles and `activeGroups`; the render queue remains the final limit on simultaneous native jobs.

The `/status` page updates every 250ms while visible, waiting for each response before scheduling the next refresh so requests never overlap. It shows effective settings and the image commit, worker/download activity, queue age, successful raster cache hits, bytes sent, disconnects, and median/95th-percentile timings over the most recent 256 samples. Cached ready time ends before streaming the PNG; response time includes server-side transfer, not display in Gaia. Requested render queue timing starts when a real client asks for a tile and excludes earlier prefetch waiting; joining an active prefetch has zero queue wait. All render queue and other worker timings include foreground and background jobs. First tile ready measures worker start to its first saved PNG, while worker elapsed includes the full grid. PNG data sent counts successful response sizes handed to the operating system, not confirmed reception in Gaia. Counters reset on restart. Prefetch reuse tracking is bounded to the most recent 1,024 newly prefetched files, so it is not a complete lifetime hit ratio. Two animated stacked bars split Rendering and Waiting into requested tiles, nearby prefetch and zoom prefetch. Rendering uses a fixed scale of worker capacity; Waiting uses the combined renderer and enabled prefetch queue limits, with unused space in grey. The Waiting figures combine pending prefetch checks and jobs waiting for a render worker; Rendering counts work already running. Bars transition over 200ms, respect reduced-motion preferences, and include exact counts alongside colours. The optional **Split by client** view adds anonymous per-client Rendering and Waiting bars with the same requested/nearby/zoom colours. Shared jobs count once in a separate row; work without a current client is grouped as Other work. Client labels follow the existing source-address grouping and expire after inactivity or restart; devices sharing an address may appear together. The opt-in `/readyz?clients=1` response contains only anonymous labels and counts, never addresses, tile keys or coordinates. The browser remembers the view preference and retains idle rows briefly to avoid flicker. Polling pauses when the page is hidden. Render queue timing only measures time waiting for a worker, so its median may be zero while prefetch work remains. The expandable application log fetches new entries every 250ms only while open and visible; Pause freezes the view for reading. It keeps at most 500 recent entries in memory (up to 8 KiB per entry), with full container output still available in Unraid. Status polling does not request map tiles.

The viewer serves its JavaScript locally. Map data and uncached NSW glyphs/sprites still require internet access. Upstream resources are fetched from fixed provider URLs; this is not a general-purpose proxy.

## Development and verification

This work is based on published Stable revision `30852c21d80c8327fde06db851f5bfd1b7668112`, retaining its separate prefetch scheduler. The unified requested/prefetch queue experiment at `5c91fc4` was unsuccessful for the intended speed improvement and is preserved on branch `codex/archive-unsuccessful-unified-queue` and annotated tag `unsuccessful-unified-queue-2026-11-25`. The historical Git branch named `stable` is older than the published Stable image. The benchmark toolkit is retained for optional manual tests; `npm run test:benchmark` is not part of the normal application or image-release tests.

Run these commands in the **Unraid terminal** (replace the container name for stable):

```sh
docker exec -it qtopo-server-latest node scripts/admin.js test --width 8 --height 8 --concurrency 8
docker exec qtopo-server-latest node scripts/admin.js stop-test
docker exec qtopo-server-latest node scripts/admin.js clear-cache --confirm
docker exec qtopo-server-latest node scripts/admin.js status
```

These commands use a Unix socket inside the container, in a directory accessible only to the server user and root (0700 directory, 0600 socket). It has no TCP port, proxy route, or browser API. Tests always target the same container. Ctrl+C during a test stops scheduling new requests; accepted requests finish normally. One local test can run at a time. A test continues if the terminal disconnects; `stop-test` stops it and `status` shows progress.

Cache clearing pauses prefetch and new raster requests, drains accepted requests and complete metatiles, then removes rendered PNGs and sidecars only from `RASTER_DIR/v2`. Downloads, styles, user files and symlink targets are preserved. New raster requests receive temporary 503 responses with Retry-After. If workers cannot drain within five minutes, clearing fails without deleting files and normal serving resumes. Stop any local test before clearing. `--confirm` is mandatory. Gaia's saved tiles are unaffected.

For a standalone HTTP client test, the existing script remains available:

```sh
node scripts/load-tiles.js --url http://tower.local:9877 --width 8 --height 8 --concurrency 8
```

This requests 64 distinct tiles with at most eight HTTP requests in flight. It requests one tile from each 2×2 grid before the siblings, so shared metatile work does not artificially restrict the initial worker load. It reports response times, failures, cache counters and observed peak busy render jobs. Watch `/status` or Unraid's process monitor during the burst. `--url http://tower.local:9877` targets Unraid when running the script from another machine with Node; no local Docker is needed. `--help` lists the options.

The script's concurrency is client request concurrency; the container's `RENDER_CONCURRENCY` still limits render workers. Choose a new area to exercise rendering, or repeat the same area to measure cached delivery. It never deletes caches or changes settings. Server statistics include other traffic and prefetch, and busy workers can be waiting for data rather than consuming CPU. Prefetch may continue after the batch finishes. Compare worker limits only with the same tile size and similar cache/upstream conditions.

Use Node 24 LTS, matching `.nvmrc`, CI and the container. Image builds pull the current Node 24 and Ubuntu 24.04 base images so they receive maintenance updates. Node 26 is also LTS, but MapLibre Native 6.4.1 only publishes binaries for Node 20, 22 and 24; moving to 26 requires an upstream binary or a separately maintained source build of the renderer.

Direct dependencies are pinned, and `package-lock.json` records the tested dependency tree. Canvas 3.2.3 still depends on the deprecated `prebuild-install` helper; the container builds Canvas from source to avoid incompatible bundled graphics libraries. Remove that indirect dependency when Canvas provides a supported replacement.

MapLibre Native 6.4.1's indirect `minimatch` dependency is overridden to 11.0.9 to address [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). The override applies only to that native package version and can be removed when its upstream dependency range includes a fixed release.

```sh
npm ci
npm test
npm run build:sprites
NSW_CONTOURS_ENABLED=0 DATA_DIR=/tmp/qtopo node server.js
```

Native raster rendering needs the platform's graphics libraries; Linux headless operation uses Xvfb. GitHub Actions builds the amd64 Unraid image, runs native rendering checks against QLD and both NSW services at 256, 512 and 1024 pixels, verifies neighbouring-tile prefetch, and saves sample tiles as the `map-render-checks` artifact. Contour checks use a tiny offline package to verify boot preparation, native output and restart reuse; ordinary smoke containers explicitly disable the statewide download. PRs never publish latest or stable.

The live rendering checks depend on public government services. If an upstream service is down, publishing stops until the checks pass.

## Sources and credits

- [Queensland vector service](https://spatial.information.qld.gov.au/arcgis/rest/services/Hosted/Basemaps_QldBase_Topographic/VectorTileServer), © State of Queensland.
- [NSW vector basemap](https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile/VectorTileServer), © State of New South Wales (Spatial Services).
- [NSW topographic map sheets](https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Topo_Map/MapServer), © State of New South Wales (Spatial Services).
- [NSW 2 m derived contour packages](https://portal.spatial.nsw.gov.au/portal/home/item.html?id=437c0697e6524d8ebf10ad0d915bc219), © State of New South Wales, Department of Finance, Services and Innovation; [CC BY 3.0 Australia](https://creativecommons.org/licenses/by/3.0/au/). Geometry is reprojected and tiled for display; source ZIPs are retained unchanged.
- QLD point symbols use [Maki](https://github.com/mapbox/maki); its license is included with the generated sprites. NSW uses its published symbol atlas and Public Sans glyphs.
- The complete bundled default QLD glyph stack comes from [MapLibre demotiles](https://github.com/maplibre/demotiles); its source revision and license are included under `assets/fonts`. The original Latin glyph range is retained unchanged, with the remaining Unicode ranges included for expanded render areas.

The bundled NSW style is a snapshot of its published service style, with its source URL recorded in metadata. Existing local styles are never overwritten by an update.

Automatic state selection uses the shared QLD–NSW border from the [ABS ASGS 2021 State and Territory boundary](https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/STE/MapServer/0), simplified to approximately 5 metres and rounded to six decimal places. © Australian Bureau of Statistics, CC BY 4.0. The NSW vector basemap also covers the ACT. The shared border is extended across service coverage to retain river and coastal water. It is used to combine map imagery, not as a surveyed boundary.
