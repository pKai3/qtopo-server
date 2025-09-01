#!/usr/bin/env bash
set -Eeuo pipefail

log() { echo "[BOOT] $*"; }

log "starting $(date)"
log "uid=$(id -u) user=$(whoami) pwd=$(pwd)"
log "PATH=$PATH"

# ── Single-mount data layout (no symlinks) ───────────────────
export DATA_DIR="${DATA_DIR:-/data}"
export VECTOR_DIR="${VECTOR_DIR:-$DATA_DIR/vector}"
export RASTER_DIR="${RASTER_DIR:-$DATA_DIR/raster}"
export STYLE_DIR="${STYLE_DIR:-$DATA_DIR/styles}"

mkdir -p "$VECTOR_DIR" "$RASTER_DIR" "$STYLE_DIR"
log "DATA_DIR=$DATA_DIR"
log "VECTOR_DIR=$VECTOR_DIR"
log "RASTER_DIR=$RASTER_DIR"
log "STYLE_DIR=$STYLE_DIR"

# ── Node resolution (no nvm) ─────────────────────────────────
# Prefer user-supplied NODE_BIN; else add /opt/node/bin to PATH and auto-detect.
export PATH="/opt/node/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
NODE_BIN="${NODE_BIN:-}"
if [[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]]; then
  :
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [[ -x /opt/node/bin/node ]]; then
  NODE_BIN="/opt/node/bin/node"
else
  log "ERROR: Node not found (checked \$NODE_BIN, PATH, /opt/node/bin/node)"
  exit 127
fi
log "node version: $("$NODE_BIN" -v)"

# ── App/Xvfb config ──────────────────────────────────────────
APP_DIR="${APP_DIR:-/usr/src/app}"
APP_JS="${APP_JS:-server.js}"

XVFB_BIN="${XVFB_BIN:-/usr/bin/Xvfb}"
XVFB_RES="${XVFB_RES:-1024x768x24}"          # screen 0 resolution/depth
XVFB_FLAGS="${XVFB_FLAGS:--nolisten tcp}"    # extra flags (e.g. -noreset -dpi 96)
XVFB_DISPLAY_BASE="${XVFB_DISPLAY_BASE:-99}" # try :99, :100, …

# ── Sanity checks ────────────────────────────────────────────
[[ -x "$XVFB_BIN" ]] || { log "ERROR: Xvfb not found at $XVFB_BIN"; exit 3; }
[[ -f "$APP_DIR/$APP_JS" ]] || { log "ERROR: missing $APP_DIR/$APP_JS"; exit 2; }

cd "$APP_DIR"

# ── Pick a free display :N ───────────────────────────────────
DISPLAY=""
for d in $(seq "$XVFB_DISPLAY_BASE" $((XVFB_DISPLAY_BASE+20))); do
  if [[ ! -S "/tmp/.X11-unix/X$d" ]]; then
    DISPLAY=":$d"
    break
  fi
done
[[ -n "$DISPLAY" ]] || { log "ERROR: no free X display"; exit 4; }

# ── Start Xvfb (logs go to container stdout/stderr) ─────────
log "starting Xvfb on $DISPLAY (res=$XVFB_RES; flags='$XVFB_FLAGS')"
"$XVFB_BIN" "$DISPLAY" -screen 0 "$XVFB_RES" $XVFB_FLAGS > /proc/1/fd/1 2> /proc/1/fd/2 &
XVFB_PID=$!
trap 'kill -TERM "$XVFB_PID" 2>/dev/null || true' EXIT

# Wait up to ~5s for the X socket to appear
for _ in {1..50}; do
  [[ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]] && break
  sleep 0.1
done
if [[ ! -S "/tmp/.X11-unix/X${DISPLAY#:}" ]]; then
  log "ERROR: Xvfb failed to create display $DISPLAY"
  exit 5
fi

export DISPLAY="$DISPLAY"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"

log "DISPLAY=$DISPLAY"
log "launching app: $NODE_BIN $APP_DIR/$APP_JS"
# IMPORTANT: exec so this becomes PID 1 (logs go to `docker logs`)
exec "$NODE_BIN" "$APP_DIR/$APP_JS"