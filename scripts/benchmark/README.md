# Repeatable QTopo benchmarks

This directory is self-contained. A fresh checkout includes the runner, synthetic workload, portable phone/computer pan patterns, local visualizer, statistics, box plots and offline HTML export. No files from an earlier `/tmp` session are required.

The benchmark runs **one workload at a time in an existing QTopo container**. It temporarily recreates that container with different prefetch settings and clears only its regenerable `raster/v2` and `vector/v2` caches. It captures and restores the current container configuration, including RAM, CPU allowance, pins, workers, mounts, networking and restart policy. It does not change the application image, live styles, Unraid template, or other containers. Avoid using the map during a comparison; the saved request logs let the analysis detect unrelated traffic.

## Quick start from your computer

Requirements: Python **3.12+** and OpenSSH locally. The Docker host needs Bash, Docker, curl, jq, flock, timeout, readlink and tar. The target QTopo image needs Node **24+**, a finite Docker memory cap, a writable `/data` bind mount and its HTTP port published on localhost. No Python or plotting packages are required on Tower.

Check the target without restarting it, clearing caches, or requesting tiles:

```sh
python3 scripts/benchmark/remote.py --host root@tower.local --check
```

Run the phone replay that permits movement before every tile arrives, comparing prefetch off, radius 1 and radius 4 sequentially:

```sh
python3 scripts/benchmark/remote.py --host root@tower.local --preset partial
```

Use `--container qtopo-server-latest` to select Latest. The default is `qtopo-server-stable`. For a different SSH address with an existing hostname entry in known_hosts, add `--ssh-option HostKeyAlias=tower.local`. Normal SSH authentication and host verification are used.

The launcher prints progress and the new local results directory, streams events for the viewer, collects reports automatically, and writes `comparison.csv`, `comparison.json` and `replay.html`. It stages its own files in a unique directory under `/mnt/user/appdata/qtopo-benchmarks/` on Tower; change that with `--work-root`. Use a persistent location so recovery records survive a host restart. No image is built or pulled.

Presets:

| Preset | Runs |
| --- | --- |
| `partial` | Phone partial-delivery replay, radii 0, 1 and 4 |
| `synthetic` | One synthetic stress/steady-pan run at radius 2 |
| `sweep` | Synthetic and fixed-timing phone workloads at radii 0–4, plus radius 2 without zoom prefetch or preemption |
| `confirm` | Selected repeats, full phone route with pauses, wait-for-all phone replays, and computer replays |

A radius of zero disables all prefetch in the tested server, including zoom prefetch. Describe it as **prefetch off**.

## Watch or replay results

Use the path printed by the launcher:

```sh
python3 scripts/benchmark/serve.py --events benchmark-results/SESSION/events.jsonl
```

Open <http://127.0.0.1:8766/>. The viewer is local and read-only: it never requests map imagery. It shows actual tile coordinates and request states, live resolved-request progress, a replay time scrubber, worker/memory samples, individual-tile box plots and time for 50%, 75% or all of each request burst to arrive. Cancelled/failed requests and bursts that never reach the chosen fraction are counted separately.

`replay.html` works offline without a server. To export it manually:

```sh
python3 scripts/benchmark/export.py benchmark-results/SESSION/events.jsonl benchmark-results/SESSION/replay.html
```

For standalone PNG/SVG plots, install the optional plotting dependency in a local environment:

```sh
python3 -m venv benchmark-results/plot-env
benchmark-results/plot-env/bin/pip install -r scripts/benchmark/requirements.txt
benchmark-results/plot-env/bin/python scripts/benchmark/plot.py benchmark-results/SESSION --phone
```

Omit `--phone` for the broader synthetic/full-route comparison. Raw requests, reports and recovery snapshots stay in `benchmark-results/`, excluded from both Git and Docker builds. The viewer and exported report contain tile coordinates, so treat saved reports as local data unless you intend to share them.

## Run directly on the Docker host

Copy or check out the repository on a persistent host path. Each invocation captures a fresh snapshot; it does not depend on a prior setup command.

```sh
export BENCHMARK_CONTAINER=qtopo-server-stable
export BENCHMARK_RESULTS_DIR="$PWD/benchmark-results/my-comparison"
bash scripts/benchmark/tower-run.sh --check
bash scripts/benchmark/tower-run.sh off 0 1 1 partial phone.json
bash scripts/benchmark/tower-run.sh nearby 1 1 1 partial phone.json
bash scripts/benchmark/tower-run.sh wider 4 1 1 partial phone.json
```

Arguments are `RUN-ID RADIUS ZOOM PREEMPT MODE TRACE`. Use distinct run IDs. `TRACE` is a bundled filename or an explicit path. `MODE` is `synthetic`, `clock`, `paced`, or `partial`.

The current resources are discovered rather than hard-coded. Non-prefetch settings must match the captured values after recreation. The default host-RAM safety margin is 4 GiB; `BENCHMARK_MIN_HOST_GIB` changes that stop threshold, not any resource allocation. `BENCHMARK_ORIGIN=http://127.0.0.1:PORT` overrides port discovery. `BENCHMARK_IDLE_CONTAINERS` lists other containers to wait for before testing; by default it checks running Stable and Latest instances and skips stopped/missing ones.

There is a per-container lock across sessions, a workload timeout, memory/restart monitoring, and an exit/signal restoration handler. Existing run directories are never overwritten. Test failures return a nonzero exit status after restoration. A failed restore retains a `restore-needed` marker and a recovery command.

After a machine crash or an interrupted SSH session, inspect the session before starting another benchmark. Recover the selected run from its saved snapshot:

```sh
bash scripts/benchmark/tower-run.sh --restore /persistent/session/results/RUN-ID
```

The recovery command refuses to overwrite a different replacement container or use a changed image tag. Snapshots include full Docker configuration and can contain environment secrets; session directories are private and are not committed. Successful restoration verifies configuration, resource settings, image and running state. Container IDs and dynamically assigned IP addresses can change on recreation.

## Workloads and interpretation

All runs begin with cold rendered-tile and vector caches and fresh workers. Fonts, sprites and shader resources remain warm. Background work drains before the next run. Reports check complete PNG responses at the configured tile resolution, keep intentional cancellations separate from errors, and record configuration, revision, available live-style hashes and memory events.

- **Synthetic:** six batches of 24 fresh tiles; eight 12-tile jumps 1.5 seconds apart; a cached repeat; then a 6×4 view moving two columns east after delivery and a 350 ms pause.
- **`clock`:** identical recorded request-arrival and cancellation timing for every configuration. Requests originally answered HTTP 304 become full requests without conditional headers.
- **`paced`:** each request burst waits for every tile, then pauses 300 ms. This intentionally measures a wait-for-all policy; it is not a model of continuous panning.
- **`partial`:** preserves arrival timing within each burst, waits at least 100 ms after dispatch, then moves when 75% has arrived or after 1.5 seconds. Outstanding requests overlap later bursts. Recorded abandonment timers are retained. Movement time and the remaining response tail are reported separately. A trace can override `readyFraction`, `minPauseMs`, and `maxPauseMs` in `replayPolicy`.

Bursts split at a 350 ms quiet gap or a profile/zoom change. They are inferred request groups, **not known viewports**. Browser-cached tiles and camera gestures are not recorded. Partial-delivery thresholds are explicit assumptions, not measured user behaviour. Do not pool different replay modes, and do not select a winner solely from the wait-for-all route duration. Keep typical delivery, slow tails, cancellations, burst readiness and movement time distinct.

Timing ends when a complete PNG reaches the benchmark inside the server. It excludes phone networking and Gaia's display time. A single pass is a screening result; repeat promising alternatives before drawing a strong conclusion. Resource limits and styles should remain fixed across compared runs. `summarize.py` reports missing/extra server requests to flag interference.

## Reusable pan patterns and new recordings

Bundled `phone.json`, `phone-pauses.json` and `computer.json` retain recorded timings, zooms, relative movements, retries and cancellations. They omit capture dates and original absolute coordinates, and use a fixed inland Queensland anchor. They therefore exercise different locations from the original November comparison. The original private captures and reports remain in the local `benchmark-results/2026-11-24/` directory; they are not needed to run the bundled patterns.

To record a new session, keep other map clients idle and capture container logs with their built-in timestamps:

```sh
ssh root@tower.local 'docker logs --since 1s -f qtopo-server-stable' > benchmark-results/capture.log
```

After panning, stop the log stream and select the active interval explicitly, including the date and timezone. The parser matches overlapping retries by response duration rather than assuming completion order:

```sh
python3 scripts/benchmark/parse-human.py benchmark-results/capture.log benchmark-results/my-pan.json --start ISO-START --end ISO-END --kind human-phone
```

Use that private trace directly, or create a portable pattern without its original location/date:

```sh
python3 scripts/benchmark/normalize.py benchmark-results/my-pan.json benchmark-results/portable-pan.json
python3 scripts/benchmark/translate.py benchmark-results/portable-pan.json benchmark-results/shifted-pan.json --dx -1 --dy 0
```

Relative traces store `baseZoom`, an `anchor` tile at that zoom, and signed tile offsets. Integer shifts at the base zoom preserve parent/child relationships at every zoom. Check the destination region before benchmarking; different terrain can change rendering cost.

## Validation

```sh
npm run test:benchmark
```

The trace tests run without a server. The host-runner tests use a fake Docker daemon and verify cold-cache scope, preservation of nonstandard limits/styles, successful restoration, failed workload/create recovery, manual recovery, read-only checks and unsafe-path rejection. They do not render tiles or touch real containers. The JavaScript tests also run in the repository's normal test suite.
