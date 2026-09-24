#!/usr/bin/env bash
set -Eeuo pipefail
export DATA_DIR="${DATA_DIR:-/data}"
export VECTOR_DIR="${VECTOR_DIR:-$DATA_DIR/vector}"
export RASTER_DIR="${RASTER_DIR:-$DATA_DIR/raster}"
export STYLE_DIR="${STYLE_DIR:-$DATA_DIR/styles}"
umask 0002
# Unraid normally uses nobody:users (99:100). Ownership changes are opt-in.
if [[ "$(id -u)" == 0 && -n "${PUID:-}" ]]; then
  [[ "$PUID" =~ ^[0-9]+$ && "$PUID" -gt 0 && "${PGID:-}" =~ ^[0-9]+$ ]] || { echo "PUID and PGID must both be numeric"; exit 2; }
  for dir in "$DATA_DIR" "$VECTOR_DIR" "$RASTER_DIR" "$STYLE_DIR" "$DATA_DIR/resources"; do
    mkdir -p "$dir"
    chown "$PUID:$PGID" "$dir"
  done
  if [[ "${FIX_PERMISSIONS:-0}" == 1 ]]; then
    chown -R "$PUID:$PGID" "$DATA_DIR" "$VECTOR_DIR" "$RASTER_DIR" "$STYLE_DIR"
  fi
  exec gosu "$PUID:$PGID" "$0" "$@"
fi
mkdir -p "$VECTOR_DIR" "$RASTER_DIR" "$STYLE_DIR"
export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 1024x768x24 -nolisten tcp &
xvfb_pid=$!
app_pid=""
cleanup() {
  [[ -z "$app_pid" ]] || kill -TERM "$app_pid" 2>/dev/null || true
  kill -TERM "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 0' TERM INT
for _ in {1..50}; do
  [[ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]] && break
  kill -0 "$xvfb_pid" 2>/dev/null || { echo "Xvfb failed"; exit 1; }
  sleep 0.1
done
[[ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]] || { echo "Xvfb not ready"; exit 1; }
node server.js &
app_pid=$!
wait "$app_pid"
