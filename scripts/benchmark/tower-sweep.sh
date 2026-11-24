#!/bin/bash
set -euo pipefail
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export BENCHMARK_RESULTS_DIR=${BENCHMARK_RESULTS_DIR:-$base/../../benchmark-results/$(date -u +%Y%m%dT%H%M%SZ)-$$}
mkdir -p "$BENCHMARK_RESULTS_DIR"
# Every configuration starts from the same complete workload.
bash "$base/tower-run.sh" r2-synthetic 2 1 1 synthetic synthetic.json
bash "$base/tower-run.sh" r2-phone 2 1 1 clock phone.json
for spec in 'r4 4 1 1' 'r0 0 1 1' 'r1 1 1 1' 'r3 3 1 1' 'r2-nozoom 2 0 1' 'r2-nointerrupt 2 1 0'; do
 read -r name radius zoom preempt <<< "$spec"
 bash "$base/tower-run.sh" "$name-synthetic" "$radius" "$zoom" "$preempt" synthetic synthetic.json
 bash "$base/tower-run.sh" "$name-phone" "$radius" "$zoom" "$preempt" clock phone.json
done
jq -nc '{message:"Screening sweep complete. Original settings restored. Awaiting comparison and selected repeat runs."}' >> "$BENCHMARK_RESULTS_DIR/events.jsonl"
