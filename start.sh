#!/usr/bin/env bash
set -Eeuo pipefail
export DATA_DIR="${DATA_DIR:-/data}"
export VECTOR_DIR="${VECTOR_DIR:-$DATA_DIR/vector}"
export RASTER_DIR="${RASTER_DIR:-$DATA_DIR/raster}"
export STYLE_DIR="${STYLE_DIR:-$DATA_DIR/styles}"
export PROFILE_DIR="${PROFILE_DIR:-$DATA_DIR/profiles}"
# Numeric Unraid users may not have a writable home directory. Share compiled
# shaders across workers in the mounted data directory instead.
export MESA_SHADER_CACHE_DIR="${MESA_SHADER_CACHE_DIR:-$DATA_DIR/resources/mesa}"
umask 0002
# Unraid normally uses nobody:users (99:100). Ownership changes are opt-in.
if [[ "$(id -u)" == 0 && -n "${PUID:-}" ]]; then
  [[ "$PUID" =~ ^[0-9]+$ && "$PUID" -gt 0 && "${PGID:-}" =~ ^[0-9]+$ ]] || { echo "PUID and PGID must both be numeric"; exit 2; }
  for dir in "$DATA_DIR" "$VECTOR_DIR" "$RASTER_DIR" "$STYLE_DIR" "$PROFILE_DIR" "$DATA_DIR/resources" "$MESA_SHADER_CACHE_DIR"; do
    mkdir -p "$dir"
    chown "$PUID:$PGID" "$dir"
  done
  if [[ "${FIX_PERMISSIONS:-0}" == 1 ]]; then
    chown -R "$PUID:$PGID" "$DATA_DIR" "$VECTOR_DIR" "$RASTER_DIR" "$STYLE_DIR" "$PROFILE_DIR"
  fi
  exec gosu "$PUID:$PGID" "$0" "$@"
fi
mkdir -p "$VECTOR_DIR" "$RASTER_DIR" "$STYLE_DIR" "$PROFILE_DIR" "$MESA_SHADER_CACHE_DIR"
# Workers connect only while rendering. Keep the display alive between jobs so
# disconnecting the last worker does not reset it and recompile the keyboard map.
# Let Xvfb select a free display instead of trusting an old :99 socket after a
# container restart. Only our new X server can write this private ready file.
display_file=$(mktemp /tmp/qtopo-display.XXXXXX)
xvfb_pid="" app_pid="" display_failure="" display_dead=0
cleanup() {
  [[ -z "$app_pid" ]] || kill -TERM "$app_pid" 2>/dev/null || true
  [[ -z "$xvfb_pid" || "$display_dead" == 1 ]] || kill -TERM "$xvfb_pid" 2>/dev/null || true
  rm -f "$display_file" "$display_file.error"
}
trap cleanup EXIT
trap 'exit 0' TERM INT
record_display_exit() {
  local status=0
  wait "$xvfb_pid" || status=$?
  display_dead=1
  display_failure="Xvfb process exited (status $status)"
}
Xvfb -displayfd 3 -screen 0 1024x768x24 -nolisten tcp -noreset 3>"$display_file" &
xvfb_pid=$!
display_number=""
for _ in {1..50}; do
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    record_display_exit
    echo "[DISPLAY] $display_failure during startup" >&2
    exit 1
  fi
  if read -r display_number < "$display_file" && [[ "$display_number" =~ ^[0-9]+$ ]]; then break; fi
  display_number=""
  sleep 0.1
done
[[ -n "$display_number" ]] || { echo "[DISPLAY] Xvfb did not become ready" >&2; exit 1; }
export DISPLAY=":$display_number"
check_display() {
  local status=0
  # Never reuse stderr from an earlier check when the X server has exited.
  : > "$display_file.error"
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    record_display_exit
    return 1
  fi
  timeout --kill-after=1s 3s xdpyinfo -display "$DISPLAY" >/dev/null 2>"$display_file.error" || status=$?
  # Xvfb may have died while the connection attempt was in progress.
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    record_display_exit
    return 1
  fi
  case "$status" in
    0) return 0 ;;
    124) display_failure="display probe timed out after 3s (status 124)" ;;
    137) display_failure="display probe was killed (status 137; timeout kill-after limit 1s)" ;;
    *) display_failure="display probe exited with status $status" ;;
  esac
  return 1
}
if ! check_display; then
  echo "[DISPLAY] Xvfb $DISPLAY (PID $xvfb_pid) is not accepting connections: $display_failure; server will not start" >&2
  cat "$display_file.error" >&2 2>/dev/null || true
  exit 1
fi
echo "[DISPLAY] Xvfb ready on $DISPLAY (PID $xvfb_pid)"
node server.js &
app_pid=$!
# An HTTP-only health check cannot detect a dead graphics server. A busy display
# can miss one probe; require three consecutive failures while it is still alive.
# A dead X server fails immediately. The restart policy can then recover service.
display_failures=0
while kill -0 "$app_pid" 2>/dev/null; do
  sleep 2
  kill -0 "$app_pid" 2>/dev/null || break
  if check_display; then
    if (( display_failures > 0 )); then
      echo "[DISPLAY] Xvfb $DISPLAY connection recovered after $display_failures failed check(s)"
    fi
    display_failures=0
  else
    display_failures=$((display_failures + 1))
    echo "[DISPLAY] Xvfb $DISPLAY (PID $xvfb_pid) check failed ($display_failures/3): $display_failure" >&2
    cat "$display_file.error" >&2 2>/dev/null || true
    if [[ "$display_dead" == 1 ]] || (( display_failures >= 3 )); then
      echo "[DISPLAY] Xvfb $DISPLAY failed; stopping the server so the container can restart" >&2
      exit 1
    fi
  fi
done
wait "$app_pid"
