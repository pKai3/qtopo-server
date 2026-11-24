#!/usr/bin/env bash
# Run on the Docker host. Only prefetch options and disposable caches are changed.
set -Eeuo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$script_dir/../.." && pwd)
name=${BENCHMARK_CONTAINER:-qtopo-server-stable}
results=${BENCHMARK_RESULTS_DIR:-$repo_dir/benchmark-results/$(date -u +%Y%m%dT%H%M%SZ)-$$}
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
 cat <<'HELP'
Run on the Docker host:
  bash scripts/benchmark/tower-run.sh --check
  bash scripts/benchmark/tower-run.sh RUN RADIUS ZOOM PREEMPT MODE TRACE
  bash scripts/benchmark/tower-run.sh --restore RUN-DIRECTORY
MODE: synthetic, clock, paced, partial. TRACE: path, or a bundled trace name.
Environment: BENCHMARK_CONTAINER, BENCHMARK_RESULTS_DIR, BENCHMARK_ORIGIN,
BENCHMARK_IDLE_CONTAINERS (space-separated), BENCHMARK_MIN_HOST_GIB (default 4).
--check is read-only. A real run stops/recreates the selected container and clears
its raster/v2 and vector/v2 caches. Its current configuration is restored on exit.
HELP
}
[[ ${1:-} != --help ]] || { usage; exit 0; }
for tool in docker curl jq flock timeout readlink; do command -v "$tool" >/dev/null || fail "Missing dependency: $tool"; done
[[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail 'Invalid container name'
api() { curl -fsS --max-time 60 --unix-socket /var/run/docker.sock "$@"; }
notice() { jq -nc --arg message "$*" '{message:$message}' | tee -a "$results/events.jsonl"; }
origin_for() {
 docker inspect "$1" | jq -er '.[0].HostConfig.PortBindings["8080/tcp"][0] |
 if .HostPort and (.HostIp=="" or .HostIp=="0.0.0.0" or .HostIp=="127.0.0.1")
 then "http://127.0.0.1:"+.HostPort else error("Set BENCHMARK_ORIGIN for this port binding") end'
}
ready() { curl -fsS --max-time 3 "$origin/readyz"; }
wait_ready() {
 for ((i=0;i<45;i++)); do if ready > "$run_dir/ready.json" 2>/dev/null; then return; fi; sleep 1; done
 return 1
}
wait_idle() {
 local url=$1 status
 for ((i=0;i<100;i++)); do
  status=$(curl -fsS --max-time 3 "$url/readyz") || return 1
  if jq -e '(.renderer.active + .renderer.queued + .requests.active + (.prefetch.active//0) + (.prefetch.queued//0) + (.prefetch.tracked//0) + .cache.downloads.active + .cache.downloads.queued)==0' <<< "$status" >/dev/null; then return; fi
  sleep 1
 done
 return 1
}
# One lock per container across all sessions, including manual recovery.
lock() { exec 9>"/tmp/qtopo-benchmark-$name.lock"; flock -n 9 || fail "Another benchmark owns $name"; }
check_image() {
 local tag expected
 tag=$(jq -r '.[0].Config.Image' "$run_dir/original-inspect.json")
 expected=$(jq -r '.[0].Image' "$run_dir/original-inspect.json")
 [[ "$(docker image inspect -f '{{.Id}}' "$tag")" == "$expected" ]] || { printf '%s\n' 'Image tag changed; refusing replacement' >&2; return 1; }
}
recreate() {
 local payload=$1 current
 check_image || return 1
 if current=$(docker inspect -f '{{.Id}}' "$name" 2>/dev/null); then
  [[ "$current" == "$(jq -r '.[0].Id' "$run_dir/original-inspect.json")" || ( -f "$run_dir/test-id" && "$current" == "$(cat "$run_dir/test-id")" ) ]] || return 1
  docker stop --time 30 "$name" >/dev/null || return 1
  docker rm "$name" >/dev/null || return 1
 fi
 api -H 'Content-Type: application/json' -X POST --data-binary "@$payload" "http://localhost/containers/create?name=$name" > "$run_dir/create-response.json" || return 1
 jq -er .Id "$run_dir/create-response.json" > "$run_dir/test-id" || return 1
 docker start "$name" >/dev/null
}
restore_config() {
 [[ -f "$run_dir/restore-needed" ]] || return 0
 notice "Restoring original settings for $name"
 recreate "$run_dir/original-create.json" || return 1
 wait_ready || return 1
 docker inspect "$name" > "$run_dir/restored-inspect.json"
 jq -e -n --slurpfile before "$run_dir/original-inspect.json" --slurpfile after "$run_dir/restored-inspect.json" '
 $before[0][0] as $b | $after[0][0] as $a |
 $a.Config==$b.Config and $a.HostConfig==$b.HostConfig and $a.Image==$b.Image and $a.State.Running' >/dev/null || return 1
 rm "$run_dir/restore-needed"
 notice "Original settings restored for $name"
}
if [[ ${1:-} == --restore ]]; then
 run_dir=$(cd "${2:?run directory required}" && pwd)
 results=$(dirname "$run_dir")
 name=$(jq -r '.[0].Name|ltrimstr("/")' "$run_dir/original-inspect.json")
 origin=$(cat "$run_dir/origin")
 lock
 restore_config || fail "Restore failed. Recovery files remain in $run_dir"
 exit 0
fi
[[ $(docker inspect -f '{{.State.Running}}' "$name") == true ]] || fail 'Target container must already be running'
origin=${BENCHMARK_ORIGIN:-$(origin_for "$name")}
[[ "$origin" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]] || fail 'BENCHMARK_ORIGIN must be the host-local HTTP port of the target container'
lock
inspect=$(docker inspect "$name")
data=$(jq -er '.[0].Mounts | map(select(.Destination=="/data" and .Type=="bind" and .RW)) | if length==1 then .[0].Source else error("Expected one writable /data bind") end' <<< "$inspect")
[[ "$data" == /* && "$data" != / && -d "$data" && ! -L "$data" ]] || fail 'Unsafe /data bind path'
for path in "$data/raster" "$data/vector" "$data/raster/v2" "$data/vector/v2"; do [[ ! -L "$path" ]] || fail "Cache path is a symlink: $path"; done
memory=$(jq -r '.[0].HostConfig.Memory' <<< "$inspect")
[[ "$memory" =~ ^[0-9]+$ && "$memory" -gt 0 ]] || fail 'Set a finite Docker memory cap before benchmarking'
before=$(ready)
jq -e '.settings.tilePx > 0 and .settings.renderConcurrency > 0 and .settings.upstreamConcurrency > 0' <<< "$before" >/dev/null || fail 'Unexpected QTopo readiness response'
docker exec "$name" node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || fail 'Target requires Node 24 or newer'
if [[ ${1:-} == --check ]]; then
 jq -n --arg container "$name" --arg origin "$origin" --argjson memory "$memory" --argjson status "$before" '{container:$container,origin:$origin,memoryBytes:$memory,revision:$status.revision,settings:$status.settings}'
 exit 0
fi
run=${1:?run ID required}; radius=${2:?radius required}; zoom=${3:?zoom required}; preempt=${4:?preemption required}; workload=${5:?mode required}; trace=${6:?trace required}
[[ "$run" =~ ^[a-z0-9-]+$ && "$radius" =~ ^[0-4]$ && "$zoom" =~ ^[01]$ && "$preempt" =~ ^[01]$ && "$workload" =~ ^(synthetic|clock|paced|partial)$ ]] || fail 'Invalid run arguments'
if [[ ! -f "$trace" ]]; then trace="$script_dir/traces/$trace"; fi
[[ -f "$trace" ]] || fail "Missing trace: $trace"
trace=$(readlink -f "$trace")
mkdir -p "$results"; results=$(cd "$results" && pwd)
run_dir="$results/$run"
[[ ! -e "$run_dir" ]] || fail 'Run ID already exists; use a new ID or results directory'
if [[ -f "$results/baseline-inspect.json" ]]; then
 [[ "$(jq -c '.[0]|{Name,Config,HostConfig,Image}' <<< "$inspect")" == "$(jq -c '.[0]|{Name,Config,HostConfig,Image}' "$results/baseline-inspect.json")" ]] || fail 'Configuration changed between comparisons; start a new results session'
else
 printf '%s\n' "$inspect" > "$results/baseline-inspect.json"
fi
mkdir "$run_dir"
printf '%s\n' "$inspect" > "$run_dir/original-inspect.json"
printf '%s\n' "$before" > "$run_dir/before.json"
printf '%s\n' "$origin" > "$run_dir/origin"
jq '.[0] as $c | $c.Config + {HostConfig:$c.HostConfig,NetworkingConfig:{EndpointsConfig:($c.NetworkSettings.Networks|with_entries(.value |= {IPAMConfig,Links,Aliases,DriverOpts}))}}' "$run_dir/original-inspect.json" > "$run_dir/original-create.json"
jq --arg radius "$radius" --arg zoom "$zoom" --arg preempt "$preempt" '.Env |= (map(select(test("^(PREFETCH_RADIUS|PREFETCH_ZOOM|PREFETCH_PREEMPT)=")|not)) + ["PREFETCH_RADIUS="+$radius,"PREFETCH_ZOOM="+$zoom,"PREFETCH_PREEMPT="+$preempt])' "$run_dir/original-create.json" > "$run_dir/test-create.json"
jq --argjson memory "$memory" --argjson hostMin "${BENCHMARK_MIN_HOST_GIB:-4}" '{memoryBytes:$memory,settings:.settings,hostMinGiB:$hostMin}' "$run_dir/before.json" > "$run_dir/expected.json"
# Copy and validate inputs before stopping the service. Nothing depends on /tmp from an earlier session.
docker cp "$script_dir/run.js" "$name:/tmp/qtopo-benchmark.js"
docker cp "$trace" "$name:/tmp/qtopo-trace.json"
docker exec "$name" node /tmp/qtopo-benchmark.js --validate "$workload" /tmp/qtopo-trace.json
check_image
wait_idle "$origin" || fail 'Target activity did not settle'
for peer in ${BENCHMARK_IDLE_CONTAINERS:-qtopo-server-stable qtopo-server-latest}; do
 [[ "$peer" != "$name" ]] || continue
 if [[ $(docker inspect -f '{{.State.Running}}' "$peer" 2>/dev/null || true) == true ]]; then
  wait_idle "$(origin_for "$peer")" || fail "Other map activity did not settle: $peer"
 fi
done
# Capture configuration at the last read-only boundary, not from an old session.
[[ "$(docker inspect "$name" | jq -c '.[0]|{Id,Config,HostConfig,Image}')" == "$(jq -c '.[0]|{Id,Config,HostConfig,Image}' "$run_dir/original-inspect.json")" ]] || fail 'Container configuration changed during preflight'
finish() {
 local result=$?
 trap - EXIT INT TERM HUP
 if ! restore_config; then
  printf 'RESTORATION FAILED. Run: bash %q --restore %q\n' "$script_dir/tower-run.sh" "$run_dir" >&2
  result=1
 fi
 exit "$result"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT TERM
notice "Preparing $run on $name: radius $radius, zoom $zoom, preemption $preempt; cold raster/vector caches"
touch "$run_dir/restore-needed"
docker stop --time 30 "$name" >/dev/null
rm -rf -- "$data/raster/v2" "$data/vector/v2"
recreate "$run_dir/test-create.json"
wait_ready
jq -e --argjson radius "$radius" --argjson zoom "$zoom" --argjson preempt "$preempt" '.settings.prefetchRadius==$radius and .settings.prefetchZoom==($zoom==1) and .settings.prefetchPreempt==($preempt==1)' "$run_dir/ready.json" >/dev/null
for pair in "$script_dir/run.js:qtopo-benchmark.js" "$trace:qtopo-trace.json" "$run_dir/expected.json:qtopo-expected.json"; do docker cp "${pair%:*}" "$name:/tmp/${pair##*:}"; done
notice "Starting $run"
set +e
timeout 540 docker exec "$name" node /tmp/qtopo-benchmark.js /tmp/qtopo-benchmark-report.json "$run" "$workload" /tmp/qtopo-trace.json /tmp/qtopo-expected.json | tee -a "$results/events.jsonl" | tee "$run_dir/events.jsonl"
result=${PIPESTATUS[0]}
set -e
docker cp "$name:/tmp/qtopo-benchmark-report.json" "$results/$run.json" || result=1
docker inspect "$name" > "$results/$run-inspect.json"
if [[ -f "$results/$run.json" ]]; then
 started=$(jq -r '.started' "$results/$run.json")
 docker logs --since "$started" "$name" > "$results/$run-server.log" 2>&1
fi
notice "Finished $run (exit $result). Results: $results"
exit "$result"
