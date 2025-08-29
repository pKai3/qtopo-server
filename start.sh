#!/usr/bin/env bash
set -Eeuo pipefail

log() { echo "[BOOT] $*"; }

log "starting $(date)"
log "uid=$(id -u) user=$(whoami) pwd=$(pwd)"
log "PATH=$PATH"
log "NVM_DIR=${NVM_DIR:-/root/.nvm}"

# === Single-mount data layout (no symlinks) ===
export DATA_DIR="${DATA_DIR:-/data}"
export VECTOR_DIR="${VECTOR_DIR:-$DATA_DIR/vector}"
export RASTER_DIR="${RASTER_DIR:-$DATA_DIR/raster}"
mkdir -p "$VECTOR_DIR" "$RASTER_DIR"

# === Styles bootstrap into /data ===
STYLE_DIR="${STYLE_DIR:-$DATA_DIR/styles}"
mkdir -p "$STYLE_DIR"
# The style file the app will use:
export STYLE_PATH="${STYLE_PATH:-$STYLE_DIR/style.json}"

# First-run copy: seed styles from the image without overwriting user edits later
if [ ! -s "$STYLE_PATH" ]; then
  if [ -f /usr/src/app/styles/style.json ]; then
    cp /usr/src/app/styles/style.json "$STYLE_PATH"
  fi
  if ls /usr/src/app/styles/*.json >/dev/null 2>&1; then
    cp -n /usr/src/app/styles/*.json "$STYLE_DIR"/ 2>/dev/null || true
  fi
fi

echo "[BOOT] DATA_DIR=$DATA_DIR"
echo "[BOOT] VECTOR_DIR=$VECTOR_DIR"
echo "[BOOT] RASTER_DIR=$RASTER_DIR"
echo "[BOOT] STYLE_DIR=$STYLE_DIR"
echo "[BOOT] STYLE_PATH=$STYLE_PATH"

# ---- config (can override via env) ----
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v18.20.8/bin/node}"
export PATH="$(dirname "$NODE_BIN"):${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
APP_DIR="${APP_DIR:-/usr/src/app}"
APP_JS="${APP_JS:-server.js}"

XVFB_BIN="${XVFB_BIN:-/usr/bin/Xvfb}"
XVFB_RES="${XVFB_RES:-1024x768x24}"          # screen 0 resolution/depth
XVFB_FLAGS="${XVFB_FLAGS:--nolisten tcp}"
XVFB_DISPLAY_BASE="${XVFB_DISPLAY_BASE:-99}" # try :99, :100, …

# ---- sanity checks ----
[ -x "$NODE_BIN" ] || { log "ERROR: Node not found at $NODE_BIN"; exit 127; }
[ -x "$XVFB_BIN" ] || { log "ERROR: Xvfb not found at $XVFB_BIN (install 'xvfb')"; exit 3; }
[ -f "$APP_DIR/$APP_JS" ] || { log "ERROR: missing $APP_DIR/$APP_JS"; exit 2; }

cd "$APP_DIR"
log "node version: $("$NODE_BIN" -v)"

# ---- pick a free display :N ----
DISPLAY=""
for d in $(seq "$XVFB_DISPLAY_BASE" $((XVFB_DISPLAY_BASE+20))); do
  if [ ! -S "/tmp/.X11-unix/X$d" ]; then
    DISPLAY=":$d"
    break
  fi
done
[ -n "$DISPLAY" ] || { log "ERROR: no free X display"; exit 4; }

# ---- start Xvfb ----
log "starting Xvfb on $DISPLAY (res=$XVFB_RES; flags='$XVFB_FLAGS')"
# send Xvfb's stderr/stdout to container logs
"$XVFB_BIN" "$DISPLAY" -screen 0 "$XVFB_RES" $XVFB_FLAGS > /proc/1/fd/1 2> /proc/1/fd/2 &
XVFB_PID=$!
trap 'kill -TERM "$XVFB_PID" 2>/dev/null || true' EXIT

# ---- wait for X socket to appear (max ~5s) ----
for i in {1..50}; do
  [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.1
done
if [ ! -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
  log "ERROR: Xvfb failed to create display $DISPLAY"
  exit 5
fi

export DISPLAY="$DISPLAY"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"

log "DISPLAY=$DISPLAY"
log "launching app: $NODE_BIN $APP_DIR/$APP_JS"
# IMPORTANT: exec so this becomes PID 1 (logs go to `docker logs`)
exec "$NODE_BIN" "$APP_DIR/$APP_JS"