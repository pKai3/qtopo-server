#!/bin/bash
# Compare the same partial-delivery model sequentially on Stable.
set -euo pipefail
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export BENCHMARK_RESULTS_DIR=${BENCHMARK_RESULTS_DIR:-$base/../../benchmark-results/$(date -u +%Y%m%dT%H%M%SZ)-$$}
mkdir -p "$BENCHMARK_RESULTS_DIR"
for radius in 0 1 4; do
  bash "$base/tower-run.sh" "r${radius}-partialphone" "$radius" 1 1 partial phone.json
done
printf '%s\n' '{"message":"Partial-delivery comparisons complete. Original Stable settings restored."}' >> "$BENCHMARK_RESULTS_DIR/events.jsonl"
