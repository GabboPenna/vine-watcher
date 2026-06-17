#!/usr/bin/env bash
set -euo pipefail

RUN_DIR="${RUN_DIR:-/tmp/vine-watcher-login}"
DISPLAY_ID="${DISPLAY_ID:-:99}"
VNC_PORT="${VNC_PORT:-5901}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
NOVNC_PUBLIC_HOST="${NOVNC_PUBLIC_HOST:-localhost}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
PASS_FILE="${RUN_DIR}/vine-vnc.pass"
DONE_FILE="${LOGIN_WAIT_FILE:-${RUN_DIR}/done}"

create_vnc_password() {
  if [ -n "$VNC_PASSWORD" ]; then
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    VNC_PASSWORD="$(openssl rand -hex 8)"
  else
    VNC_PASSWORD="$(date +%s%N | sha256sum | awk '{print substr($1, 1, 16)}')"
  fi
}

cleanup() {
  for pidfile in "${RUN_DIR}"/*.pid; do
    [ -f "$pidfile" ] || continue
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

mkdir -p "$RUN_DIR"
rm -f "${RUN_DIR}"/*.pid "${RUN_DIR}"/*.log "$DONE_FILE"
create_vnc_password

x11vnc -storepasswd "$VNC_PASSWORD" "$PASS_FILE" >/dev/null 2>&1
chmod 600 "$PASS_FILE"

Xvfb "$DISPLAY_ID" -screen 0 1365x900x24 -nolisten tcp >"${RUN_DIR}/xvfb.log" 2>&1 &
echo "$!" >"${RUN_DIR}/xvfb.pid"
sleep 1

DISPLAY="$DISPLAY_ID" openbox >"${RUN_DIR}/openbox.log" 2>&1 &
echo "$!" >"${RUN_DIR}/openbox.pid"

DISPLAY="$DISPLAY_ID" x11vnc \
  -display "$DISPLAY_ID" \
  -rfbauth "$PASS_FILE" \
  -forever \
  -shared \
  -rfbport "$VNC_PORT" \
  -listen 0.0.0.0 \
  >"${RUN_DIR}/x11vnc.log" 2>&1 &
echo "$!" >"${RUN_DIR}/x11vnc.pid"

novnc_web="/usr/share/novnc"
if [ ! -d "$novnc_web" ]; then
  novnc_web="/usr/share/novnc/html"
fi

websockify --web="$novnc_web" "0.0.0.0:${NOVNC_PORT}" "localhost:${VNC_PORT}" >"${RUN_DIR}/novnc.log" 2>&1 &
echo "$!" >"${RUN_DIR}/novnc.pid"

echo
echo "Temporary browser login is running."
echo "Open: http://${NOVNC_PUBLIC_HOST}:${NOVNC_PORT}/vnc.html?host=${NOVNC_PUBLIC_HOST}&port=${NOVNC_PORT}"
echo "Password: ${VNC_PASSWORD}"
echo
echo "After Amazon Vine is visible and logged in, run from the host:"
echo "  docker compose --profile login exec login touch ${DONE_FILE}"
echo

DISPLAY="$DISPLAY_ID" npm run login:server
