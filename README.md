# qtopo-server

One XYZ tile source for Gaia GPS and other mapping apps, covering Queensland and NSW automatically. Queensland uses your editable vector style; NSW uses the official NSW vector basemap. Both are rendered into PNG tiles for the GPS client. The browser supports interactive vectors and a preview of the GPS raster tile source.

## Release channels

- `docker.io/pkai3/qtopo-server:latest` — tested QLD + NSW release.
- `docker.io/pkai3/qtopo-server:stable` — confirmed QLD + NSW release through PR #14 (`15a5c79`), including padded metatiles, short tile URLs and private management controls.
- `docker.io/pkai3/qtopo-server:fallback` — original pre-chat, pre-NSW image, preserved by digest without rebuilding it.
- `:stable-before-15a5c79` — previous stable release through PR #12, retained for rollback.
- `:pre-nsw` — another permanent reference to that same pre-NSW image.
- `:stable-before-nsw` — the older stable image.
- `:sha-<commit>` — individual new releases.

The pre-NSW source is tagged `pre-nsw` in GitHub. New builds publish **latest only**, after unit tests and native Linux rendering checks. Both stable and fallback are protected by digest checks; promoting stable requires an explicit release decision.

## Unraid

Keep the existing container port **8080**, host port (for example 9878), and host folder mounted at **/data**. Map delivery does not require a template change. The status page is public and read-only. Tests and cache clearing run only through the container CLI. Raw application logs remain private unless the configured networks and hostnames permit access. No second network port or extra login is required.

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

### Status and private logs

Open `/status` on the normal server URL for public, read-only activity charts. `/readyz` returns aggregate counters and settings; it omits individual tile locations, test coordinates and local maintenance details. Enabling ZeroTier is not required to view status. The former `/api/actions/*` web endpoints return 404 for every client, including localhost and trusted proxies.

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

Use **`/raster/{z}/{x}/{y}.png`** for the automatic QLD + NSW map, at zooms 0–19. It selects the QLD or NSW vector service by location, renders the selected vector data to PNG, and combines both renders within tiles that cross the state boundary. Output is always TILE_PX (1024 by default), with the same XYZ grid as before. Keep the tile-size setting that already works for QLD in your GPS app. The 1024px output is rendered directly from vectors at double pixel density, preserving the same geographic extent and label scale. If your container explicitly sets `TILE_PX=512`, change it to `1024` to use the higher resolution.

NSW’s published tile index selects the available vector parent at high zooms, avoiding requests for nonexistent child tiles. The renderer draws those vectors at the requested zoom. Both states render directly at the configured output resolution; the automatic route does not use scanned map sheets. QLD-only tiles reuse the existing QLD cache without changing their pixels. Previously downloaded blank NSW tiles in a GPS app may need refreshing.

### Appearance profiles

The unqualified `/{z}/{x}/{y}.png` and `/raster/{z}/{x}/{y}.png` URLs follow `DEFAULT_PROFILE`, initially `classic`. Choose an **Appearance** in the viewer and use **Copy QLD + NSW tile URL** to add that profile as a separate Gaia source.

| URL path | Appearance |
|---|---|
| `/classic/{z}/{x}/{y}.png` | Existing colours, symbols and desktop sizing |
| `/readable/{z}/{x}/{y}.png` | Revised colours, water masking and icon-label placement, at original desktop size |
| `/size-2x/{z}/{x}/{y}.png` | Original colours with text, symbols and strokes enlarged 2× |
| `/size-3x/{z}/{x}/{y}.png` | Original colours with text, symbols and strokes enlarged 3× |
| `/mobile-2x/{z}/{x}/{y}.png` | Revised colours and placement, 2× features with gentler contours |
| `/mobile-3x/{z}/{x}/{y}.png` | Revised colours and placement, 3× features with gentler contours |

These names always select the current recipe; no version suffix is required. QLD/NSW selection remains automatic. The PNG dimensions, XYZ geography, source zoom thresholds and upstream features stay the same. Source data, fonts and sprites are shared; prepared styles, rendered tiles and prefetch groups are isolated by profile. Classic retains the previous cache revision exactly. Saved style files are never overwritten. Recipe changes get fresh server cache revisions without clearing any existing cache; Gaia's own saved/offline tiles still require a refresh or download to see changes.

Readable and Mobile use softer land/contour colours and stronger text halos. Power lines are thin grey dashes at every display scale. In QLD, opaque water polygons cover waterway skeleton lines inside permanent water bodies while keeping external creek segments and drawing shorelines, roads and bridges above them. QLD point symbols that previously centred icon and text together let their label choose a clear side; the icon remains at its actual location. Existing custom label offsets are respected. NSW uses its own published ordering and collision rules, with larger features and revised water/contour colours. Pre-rendered NSW map sheets cannot be restyled.

Advanced clients can request `/raster/{profile}/{provider}/{z}/{x}/{y}.png` or `/styles/{profile}/{provider}.json`. Legacy provider-specific routes follow the configured default. `/api/providers` lists all profiles and absolute tile templates; `/?profile=mobile-2x&mode=raster` opens a matching preview.

### Live profile updates

After installing the server release that supports live profiles, styles can be updated through SSH without another image build or container restart. Export a complete profile, edit its QLD and NSW style JSON, then sync it back:

```sh
ssh root@your-server 'docker exec qtopo-server-latest node scripts/profiles.js export mobile-3x -' > mobile-3x.json
# Edit mobile-3x.json, then validate and install it atomically:
ssh root@your-server 'docker exec -i qtopo-server-latest node scripts/profiles.js sync -' < mobile-3x.json
```

Use `docker exec -u <PUID>:<PGID>` when the container runs as a configured Unraid user. The CLI also accepts ordinary file paths and has `list` and `validate` commands. The JSON's `id` determines the URL: keeping `mobile-3x` updates that existing source; changing it to a new name creates another source. Classic is protected from file overrides, and syncing does not change `DEFAULT_PROFILE`.

One file contains both state styles. Sync validates it before installation and keeps the previous file under `/data/styles/history`. Sync a history file to roll back. New requests detect changes within 250 ms; in-flight requests finish with their captured style. Only changed styles get new raster cache identities, and old tiles remain available for rollback. Live profiles use immediate HTTP revalidation, but Gaia's downloaded/offline tiles may still need refreshing in the app. Invalid file edits keep the last valid in-memory profile; always use the CLI to avoid leaving invalid data on disk across a restart.

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
| DEFAULT_PROFILE | classic | Appearance for unqualified raster/style URLs; a built-in or installed profile name. Named URLs remain independent of this choice. |
| DEFAULT_PROVIDER | qld | Initial viewer location: qld, nsw, nsw-topo; automatic GPS coverage is always enabled |
| PUBLIC_URL | Request origin | External origin, e.g. https://maps.example.com, when using an HTTPS reverse proxy |
| TILE_PX | 1024 | 256, 512 or 1024 output pixels for vector-to-raster maps |
| METATILE_SIZE | 2 | Render a fixed 2×2 vector grid together; set 1 for single-tile rendering. PNG dimensions and URLs stay the same. |
| RENDER_BUFFER_PX | 64 | Border around the render area, in logical pixels at 512px per tile (128 output pixels at TILE_PX=1024). Even values 0–256; cropped before saving. Set 0 with METATILE_SIZE=1 to use the previous unpadded renderer. |
| PNG_COMPRESSION_LEVEL | 3 | Lossless PNG compression, 0–9. Try 6 for slightly smaller files at the cost of more encoding CPU; resolution and colours are unchanged. Applies to newly rendered tiles only. |
| LABEL_SCALE | 1 | Legacy extra raster text/icon multiplier, 0.5–3, applied on top of every profile; keep 1 when comparing named profiles. |
| VECTOR_UPSTREAM | QLD service | Optional QLD template containing {z}, {x}, {y} |
| RENDER_CONCURRENCY | 2 | Maximum simultaneous reusable native workers, 1–16. With a Docker memory cap, actual concurrency adapts to available memory. |
| RENDER_WORKER_MAX_RSS_MB | 384 | Replace a worker after its completed render if resident memory reaches this many MiB (64–4096). The old process exits before its slot is reused. This bounds retention between jobs, not peak memory during a single render; keep a Docker RAM limit as well. |
| LP_NUM_THREADS | 1 (Docker) | Mesa software-rendering threads per worker. Independent of `RENDER_CONCURRENCY`; avoids multiplying each worker by the host CPU count. |
| MALLOC_ARENA_MAX | 2 (Docker) | Limit glibc allocator arenas per process to reduce retained native memory. |
| MALLOC_MMAP_THRESHOLD_ | 131072 (Docker) | Allocate large native buffers separately so freeing them can return their memory to the OS. Bytes; explicit setting prevents the threshold growing with repeated renders. |
| MALLOC_TRIM_THRESHOLD_ | 131072 (Docker) | Keep glibc's heap-trimming threshold fixed so releasable heap memory is returned between renders. Bytes. |
| RENDER_QUEUE_LIMIT | 64 | Maximum queued distinct renders |
| REQUEST_PAN_THRESHOLD | 8 | Tile distance from the current area anchor before a pan moves queued requests to a new area; positive integer, measured in either axis at the requested zoom |
| PREFETCH_RADIUS | 1 | Nearby tile radius, 0–10; 0 disables prefetch. Radius 1 considers 8 neighbours, 2 considers 24, and 10 considers 440. The queue limit bounds retained work, favouring the nearest tiles around recent requests |
| PREFETCH_ZOOM | 1 | Pre-render one parent at z−1 and four children at z+1, after same-zoom neighbours; 0 disables zoom prefetch |
| PREFETCH_CONCURRENCY | RENDER_CONCURRENCY − 1 | Maximum simultaneous prefetch groups, at least 1; QLD vector siblings share a grid group, while other tile types count individually. The render queue also caps background jobs to leave a slot for requests when possible. |
| PREFETCH_QUEUE_LIMIT | 64 | Maximum pending neighbouring tiles; older queued tiles are dropped when full |
| RENDER_TIMEOUT_SECONDS | 60 | Worker deadline, maximum 300 |
| UPSTREAM_TIMEOUT_SECONDS | 20 | Download deadline, maximum 120 |
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

Parsed styles and their cache revisions are reused in memory. File metadata is checked on every access so local style edits still take effect immediately. NSW zoom variants are cached separately without altering the base style. The metatile renderer uses a new vector raster revision so old clipped images are regenerated; vector downloads and other resource caches are reused. Successful cached delivery avoids a second PNG/empty-marker lookup. Expired tiles still refresh before delivery; stale tiles are not served while refreshing in the background. Changing PNG compression does not invalidate existing tiles because their pixels are unchanged.

Vector rendering places labels across a fixed 2×2 grid plus a border before cropping four normal tiles. This keeps labels consistent across the grid's internal seams and reduces clipping at its outer edges; independently rendered grids can still make different collision decisions. The temporary larger image stays in memory. Only the usual PNG tiles are saved, with requested tiles encoded and released first. Requests for the same grid/style share one job and can promote an active prefetch job. Each worker uses more memory and the first uncached tile can take longer, while neighbouring tiles share the work. One job produces up to four tiles even when optional prefetch is disabled. NSW tiles with different source zoom limits use separate style jobs to preserve their detail. Raster map sheets and state-border compositing remain individual-tile operations.

A failed download or render returns an uncached 502/504 response. A full render queue returns 503 with Retry-After. Failures are never saved as successful blank tiles. Concurrent requests for the same resource are combined; providers remain isolated.

The container starts its own virtual display (Xvfb), choosing a free display number and verifying a real connection before starting the HTTP server. `DISPLAY` is managed internally. A dead display stops the container immediately with a nonzero exit code. A running display must fail three consecutive connection checks before shutdown, allowing a brief stall to recover. Checks run after a two-second pause, time out after three seconds, and force termination of a stuck probe after one additional second. Startup still requires a successful first check. A configured Docker restart policy can recover the service after shutdown; existing tile caches are retained. Display messages use `[DISPLAY]` in the Unraid container log and distinguish process exits, probe errors, timeouts and recovery, including exit status and available error output.

Container logs include tile requests (`REQ`), automatic state selection (`AUTO`), vector downloads and cache saves (`PBF-GET`/`PBF`), rendering and cache hits (`RDR`), and response status with elapsed time (`RES`). Transparent tiles are explicitly logged as empty. These messages appear in the Unraid container log without any extra configuration. Native renderer stdout/stderr is forwarded as `NATIVE` with the worker PID, so crash details also appear in the status-page application log. Xvfb and other container-level output remains available in Unraid.

Rendering workers are reused between tiles, including their loaded map style and resources. Idle workers are released after two minutes and busy workers are periodically recycled. PNG compression remains lossless. `/readyz` reports configured concurrency, current and peak active renders, active renders by priority, worker starts, active upstream downloads and prefetch progress. `TIMING` logs show queue delay, worker elapsed time, time with resource requests outstanding, PNG encoding time and process CPU time. Resource waiting includes local cache reads through the server and upstream downloads; CPU time can overlap resource waiting and may include multiple native threads, so these values are not additive.

When a finite Linux cgroup memory limit is present, render admission reads the whole container's working memory (including the server and idle workers, excluding reclaimable inactive file cache). It leaves 20% of the cap, at least 512 MiB, as headroom. Each new job initially reserves 512 MiB; after four completed renders it uses recent observed worker peaks plus 25%, with a 256 MiB minimum. Reservations include jobs admitted before their processes start and expected growth in running workers. Memory is sampled every 100ms and reread before admission. A failed reading pauses new renders until it recovers. Requested work retains priority over prefetch; cached tiles bypass the gate. Idle native maps are released when memory blocks queued work. No configured CPU, RAM or worker setting is rewritten.

`/readyz` exposes `renderer.memory` with current/peak working usage, current/peak total cgroup charges, worker reservation size, pause count, parent/worker/idle RSS, and released idle workers. The status page shows **Memory limited** while queued work waits for room. Per-process RSS can double-count shared pages; the cgroup working set drives admission. This is a measured admission estimate, not a hard per-job memory guarantee: unusually large single renders can exceed previous peaks. Keep Docker's hard limit. Repeated pan tests exercise 16 configured workers with a 4 GiB cap, multiple styles/zooms and prefetch, record a memory history, and check that all work drains without an OOM or restart.

Prefetch starts after a 500ms delay at the beginning of a new burst, then prepares same-zoom neighbours using spare rendering capacity even while other raster requests remain outstanding. Continuing requests do not keep resetting that initial delay. The render queue always selects waiting requested tiles first and reserves a foreground slot when possible. It never expands from prefetched tiles. Priority is: requested tiles, same-zoom neighbours, then zoom-out/zoom-in tiles. Within each prefetch tier, the newest requested location comes first, with nearer neighbours first within that location. Overlapping queued neighbours move to the newer request; an older request finishing late cannot jump ahead. When the queue fills, zoom tiles are discarded before same-zoom neighbours, then older/farther entries are discarded.

Queued work follows each client IP's latest requested zoom and area. Within each priority tier, tiles near that area's anchor at the latest zoom come first, followed by other tiles at that zoom, then older zooms. A zoom change updates the anchor immediately; a pan moves it when a request is more than `REQUEST_PAN_THRESHOLD` tiles away horizontally or vertically. Already queued tiles are re-evaluated when a worker becomes available, including when zooming back to an earlier level. Equally relevant requested jobs keep arrival order. Older jobs remain queued subject to the existing queue limits, and running jobs finish normally. Shared renders retain the best priority among the clients requesting their tiles. Focus follows request arrival even on cache hits, so an old render finishing late cannot move it back.

Focus tracking uses the client address supplied by Express's existing exact proxy trust configuration. It retains at most 256 client entries in memory and expires them after one minute without requests; IPs and focus coordinates are not added to public status. Clients sharing an IP share one inferred focus, and interleaved zoom requests can move it back and forth because standard XYZ requests do not describe the client's viewport. Normal interrupted downloads remain counted as client disconnects; confirmed closed-connection errors do not produce duplicate HTTP error stacks.

Zoom prefetch adds only the requested tile’s parent and four children, within the map’s zoom limits. Queued requests and same-zoom neighbours take priority; zoom work can use spare background capacity while those earlier jobs are still running. Requesting an already queued or running prefetch render reclassifies it as requested, sharing the existing work. The status charts count render jobs (up to four vector tiles each), not HTTP requests: cached PNG responses bypass the workers and appear in the session and cache counters. With `RENDER_CONCURRENCY=8`, prefetch can use up to seven workers by default, reserving one for incoming requests. Work already running finishes normally, so a new request waits if every worker is busy and a new neighbour may wait for running zoom work. `PREFETCH_CONCURRENCY` can lower background usage, and `PREFETCH_RADIUS=0` disables all prefetch. Prefetch uses the same state selection, resolution and cache as requested tiles and is logged as `PREFETCH` or `PREFETCH-Z`. Increasing concurrency uses more CPU and RAM; low CPU with active downloads can indicate workers waiting for data. 1024px tiles also require more rendering work, storage and bandwidth than 512px tiles.

QLD vector prefetch groups sibling tiles by their metatile grid, including automatic tiles wholly inside QLD. Waiting for several outputs from one grid no longer consumes several prefetch group slots. Each tile still checks its own output; group membership never assumes another tile was saved. NSW style variants, border composites and raster providers remain individually counted. `/readyz` reports both active prefetch tiles and `activeGroups`; the render queue remains the final limit on simultaneous native jobs.

The `/status` page updates every 250ms while visible, waiting for each response before scheduling the next refresh so requests never overlap. It shows effective settings and the image commit, worker/download activity, queue age, successful raster cache hits, bytes sent, disconnects, and median/95th-percentile timings over the most recent 256 samples. Cached ready time ends before streaming the PNG; response time includes server-side transfer, not display in Gaia. Worker timing covers foreground and background jobs. First tile ready measures worker start to its first saved PNG, while worker elapsed includes the full grid. PNG data sent counts successful response sizes handed to the operating system, not confirmed reception in Gaia. Counters reset on restart. Prefetch reuse tracking is bounded to the most recent 1,024 newly prefetched files, so it is not a complete lifetime hit ratio. Two animated stacked bars split Rendering and Waiting into requested tiles, nearby prefetch and zoom prefetch. Rendering uses a fixed scale of worker capacity; Waiting uses the combined renderer and enabled prefetch queue limits, with unused space in grey. The Waiting figures combine pending prefetch checks and jobs waiting for a render worker; Rendering counts work already running. Bars transition over 200ms, respect reduced-motion preferences, and include exact counts alongside colours. Polling pauses when the page is hidden. Render queue timing only measures time waiting for a worker, so its median may be zero while prefetch work remains. The expandable application log fetches new entries every 250ms only while open and visible; Pause freezes the view for reading. It keeps at most 500 recent entries in memory (up to 8 KiB per entry), with full container output still available in Unraid. Status polling does not request map tiles.

The viewer serves its JavaScript locally. Map data and uncached NSW glyphs/sprites still require internet access. Upstream resources are fetched from fixed provider URLs; this is not a general-purpose proxy.

## Development and verification

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
DATA_DIR=/tmp/qtopo node server.js
```

Native raster rendering needs the platform's graphics libraries; Linux headless operation uses Xvfb. GitHub Actions builds the amd64 Unraid image, runs native rendering checks against QLD and both NSW services at 256, 512 and 1024 pixels, verifies neighbouring-tile prefetch, and saves sample tiles as the `map-render-checks` artifact. PRs never publish latest or stable.

The live rendering checks depend on public government services. If an upstream service is down, publishing stops until the checks pass.

## Sources and credits

- [Queensland vector service](https://spatial.information.qld.gov.au/arcgis/rest/services/Hosted/Basemaps_QldBase_Topographic/VectorTileServer), © State of Queensland.
- [NSW vector basemap](https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile/VectorTileServer), © State of New South Wales (Spatial Services).
- [NSW topographic map sheets](https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Topo_Map/MapServer), © State of New South Wales (Spatial Services).
- QLD point symbols use [Maki](https://github.com/mapbox/maki); its license is included with the generated sprites. NSW uses its published symbol atlas and Public Sans glyphs.
- The complete bundled default QLD glyph stack comes from [MapLibre demotiles](https://github.com/maplibre/demotiles); its source revision and license are included under `assets/fonts`. The original Latin glyph range is retained unchanged, with the remaining Unicode ranges included for expanded render areas.

The bundled NSW style is a snapshot of its published service style, with its source URL recorded in metadata. Existing local styles are never overwritten by an update.

Automatic state selection uses the shared QLD–NSW border from the [ABS ASGS 2021 State and Territory boundary](https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/STE/MapServer/0), simplified to approximately 5 metres and rounded to six decimal places. © Australian Bureau of Statistics, CC BY 4.0. The NSW vector basemap also covers the ACT. The shared border is extended across service coverage to retain river and coastal water. It is used to combine map imagery, not as a surveyed boundary.
