qtopo-server

Headless vector→raster tile server with a built-in MapLibre vector viewer, automatic on-demand PBF caching, transparent raster tiles, and an editable style that lives on your host.
	•	Viewer at / (MapLibre, live style).
	•	Vector tiles at /vector/{z}/{x}/{y}.pbf (serves from cache or downloads on miss).
	•	Raster tiles at /raster/{z}/{x}/{y}.png (renders via headless MapLibre worker).
	•	Glyphs at /fonts/{fontstack}/{range}.pbf.
	•	Style served at /style.json (always the editable one from /data/styles/style.json).
	•	Legacy redirect: /tiles_raster/... → /raster/... (308).

Features
	•	Single host volume: /data (bind-mount in Docker/Unraid)
	•	/data/vector — cached vector PBFs
	•	/data/raster — rendered PNG tiles
	•	/data/styles/style.json — editable MapLibre style (seeded on first boot)
	•	Download-on-miss: missing PBFs are fetched from the upstream and cached.
	•	Zero-byte sentinel: out-of-bounds upstream responses cached as 0-byte PBF → served as blank.png.
	•	Graceful fallbacks:
	•	blank tile if PBF empty
	•	error tile if render fails
	•	Transparent PNG output by default (vector background made transparent).
	•	Cleanup job with TTL per tree (raster & vector). 0 = keep forever.
	•	Viewer style URL hardening: /style.json rewrites relative tiles/glyphs to absolute URLs so MapLibre workers never choke on relative paths.
	•	Fonts served locally (/fonts/...), URL-decoded, with multi-root fallback.

⸻

Run (Docker / Unraid)

Quick start (Docker CLI)

docker run -d --name qtopo \
  -p 9877:8080 \
  -v /path/on/host/qtopo-data:/data \
  -e TZ="Australia/Brisbane" \
  docker.io/pkai3/qtopo-server:latest

Open: http://<host>:9877/ (vector viewer).
Fetch a raster tile: http://<host>:9877/raster/13/7551/4724.png

Unraid (recommended)
	•	Image: pkai3/qtopo-server:latest (or :stable)
	•	Port: container 8080 → host 9877 (or your choice)
	•	Volume: /data → /mnt/user/appdata/qtopo-server
	•	Env: set as needed (see below)

⸻

Environment variables

Var	Default	Purpose
PORT	8080	HTTP port (container)
DATA_DIR	/data	Root for vector/raster/styles
VECTOR_DIR	$DATA_DIR/vector	Override vector cache path
RASTER_DIR	$DATA_DIR/raster	Override raster output path
STYLE_PATH	set by server	Always /data/styles/style.json after seeding; exported to worker env
VECTOR_UPSTREAM	QLD service	Template URL for upstream PBF fetch ({z}/{y}/{x}.pbf)
RASTER_TTL_HOURS	72	Delete raster tiles older than N hours; 0 = keep forever
VECTOR_TTL_HOURS	0	Delete vector tiles older than N hours; 0 = keep forever
CLEANUP_INTERVAL_MINUTES	15	Cleanup cadence
CLEAR_RASTER_ON_BOOT	unset	If 1, wipe $RASTER_DIR at boot
TILE_PX	256	PNG tile size produced by renderer (256 is best for GPS apps; 512 for retina)
LABEL_SCALE	1	Multiplier for text-size, icon-size, and (optionally) line-width during raster render

Perms (Unraid): you can also use PUID/PGID if you added that logic; otherwise the container runs as root and normal host shares work fine. The server sets umask 002 so files are group-writable.

⸻

Editable style (host)
	•	On first boot, the server seeds /data/styles/style.json from the baked copy.
	•	The server always uses /data/styles/style.json. If it’s missing/unreadable, the process fails fast.
	•	The viewer serves the same file at /style.json and rewrites tiles/glyphs to absolute URLs.

Edit /data/styles/style.json on your host and refresh the viewer.
The renderer (worker) also reads the same path via STYLE_PATH env.

⸻

HTTP Endpoints
	•	GET / — static viewer (public/index.html)
	•	GET /style.json — active style (editable), with absolute URLs
	•	GET /vector/{z}/{x}/{y}.pbf — serve from cache or download & cache on miss (long-cache headers)
	•	GET /raster/{z}/{x}/{y}.png — render PNG (transparent); caches on disk
	•	GET /fonts/{fontstack}/{range}.pbf — serves glyphs (URL-decoded fontstack)
	•	GET /tiles_raster/{z}/{x}/{y}.png — 308 redirect to /raster/...
	•	GET /healthz — optional health probe (add if you want)

⸻

Directory layout (container)

/usr/src/app
  ├─ server.js               # Express server
  ├─ render_worker.js        # Headless raster rendering
  ├─ start.sh                # Boots Xvfb + node
  ├─ assets/
  │   ├─ fonts/<stack>/<range>.pbf
  │   └─ images/{blank.png,error.png}
  ├─ styles/style.json       # baked style (seed source)
  └─ public/                 # viewer files (index.html, regions.geojson, etc.)

/data (mounted)
  ├─ vector/                 # cached PBFs
  ├─ raster/                 # rendered PNGs
  └─ styles/style.json       # EDIT THIS ONE


⸻

Rendering profiles (desktop vs GPS apps)
	•	Desktop/retina: TILE_PX=512, LABEL_SCALE=1.0
	•	GPS apps (many assume 256px tiles): TILE_PX=256, and optionally LABEL_SCALE=1.3–1.6 to make text/lines bigger in rasters.

Run two containers with different env to serve separate ports if you want both.

⸻

CI/CD & tags
	•	GitHub Actions build on pushes to master (or main) → pkai3/qtopo-server:latest
	•	Pushes to stable → pkai3/qtopo-server:stable
	•	Promote by fast-forwarding stable to the desired commit (PR or merge).
Then Force Update the Unraid container tracking :stable.

⸻

Troubleshooting

Viewer loads but vector tiles don’t appear, no server logs
	•	Your style had relative URLs. /style.json already rewrites tiles/glyphs to absolute URLs—make sure you’re using /style.json in the viewer (style: '/style.json').

Fonts 404
	•	Hit a font URL directly:

curl -I "http://host:port/fonts/Open%20Sans%20Regular%2cArial%20Unicode%20MS%20Regular/0-255.pbf"


	•	Ensure the server has the /fonts route and your font folder exists under assets/fonts/…. The server URL-decodes the folder name.

Renderer uses the baked style
	•	The worker must read STYLE_PATH from env. The server exports process.env.STYLE_PATH = '/data/styles/style.json' and spawns the worker with env: process.env. Verify logs show [WORKER] STYLE=/data/styles/style.json.

Blank tiles at borders
	•	Zero-byte PBFs are cached and raster returns blank.png. That’s expected for out-of-bounds tiles.

spawn node ENOENT
	•	Use the provided start.sh which starts Xvfb and launches Node with the right PATH. Don’t call xvfb-run in CMD; the script manages display and logging.

⸻

Development

# install deps
npm install

# run locally (needs Xvfb if headless)
./start.sh
# or: DISPLAY=:0 node server.js (if you have a real display)


⸻

Credits
	•	MapLibre GL Native / MapLibre GL JS
	•	Open Sans, Arial Unicode MS glyph PBFs
	•	Queensland Spatial Information (upstream vector tiles)

⸻

License

None
