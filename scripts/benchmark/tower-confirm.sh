#!/bin/bash
set -euo pipefail
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export BENCHMARK_RESULTS_DIR=${BENCHMARK_RESULTS_DIR:-$base/../../benchmark-results/$(date -u +%Y%m%dT%H%M%SZ)-$$}
mkdir -p "$BENCHMARK_RESULTS_DIR"
run() { bash "$base/tower-run.sh" "$@"; }
# Repeat in a different order to check whether the initial result was timing noise.
run r0-repeat-synthetic 0 1 1 synthetic synthetic.json
run r2-repeat-synthetic 2 1 1 synthetic synthetic.json
run r0-repeat-phone 0 1 1 clock phone.json
run r2-repeat-phone 2 1 1 clock phone.json
# Retain pauses from the full phone route; compare the leader, nearest-prefetch
# alternative, and the user's current radius 4.
run r0-fullphone 0 1 1 clock phone-pauses.json
run r1-fullphone 1 1 1 clock phone-pauses.json
run r4-fullphone 4 1 1 clock phone-pauses.json
# Same bursts, advancing after delivery rather than at prerecorded times.
run r0-pacedphone 0 1 1 paced phone.json
run r1-pacedphone 1 1 1 paced phone.json
run r4-pacedphone 4 1 1 paced phone.json
# Preserve and exercise the independently recorded computer pattern too.
run r0-computer 0 1 1 clock computer.json
run r4-computer 4 1 1 clock computer.json
jq -nc '{message:"Confirmation runs complete. Original Stable settings restored."}' >> "$BENCHMARK_RESULTS_DIR/events.jsonl"
