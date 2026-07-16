#!/usr/bin/env bash
set -euo pipefail

DEFAULTS_FILE="${VINE_WATCHER_DEFAULTS_FILE:-/etc/default/vine-watcher}"
VINE_WATCHER_APP_DIR=""
VINE_WATCHER_SERVICE_USER=""
if [ -r "$DEFAULTS_FILE" ]; then
  # Written by install-debian.sh; contains only validated paths and account names.
  # shellcheck source=/dev/null
  source "$DEFAULTS_FILE"
fi
APP_DIR="${APP_DIR:-${VINE_WATCHER_APP_DIR:-/opt/vine-watcher-telegram}}"
SERVICE_USER="${SERVICE_USER:-${VINE_WATCHER_SERVICE_USER:-vinewatcher}}"
RUN_DIR="${RUN_DIR:-/tmp/vine-watcher-login}"
DISPLAY_ID="${DISPLAY_ID:-:99}"
VNC_PORT="${VNC_PORT:-5901}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
PASS_FILE="/var/lib/${SERVICE_USER}/vine-vnc.pass"
DONE_FILE="${RUN_DIR}/done"

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run this command as root, for example: sudo $0 $*" >&2
    exit 1
  fi
}

stop_processes() {
  mkdir -p "$RUN_DIR"
  for name in login novnc x11vnc openbox xvfb; do
    local pidfile="${RUN_DIR}/${name}.pid"
    if [ -f "$pidfile" ]; then
      local pid
      pid="$(cat "$pidfile" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pidfile"
    fi
  done
  rm -f "$PASS_FILE"
}

create_vnc_password() {
  if [ -n "$VNC_PASSWORD" ]; then
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    VNC_PASSWORD="$(openssl rand -hex 8)"
  elif command -v python3 >/dev/null 2>&1; then
    VNC_PASSWORD="$(
      python3 -c 'import secrets, string; print("".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16)))'
    )"
  else
    VNC_PASSWORD="$(date +%s%N | sha256sum | awk '{print substr($1, 1, 16)}')"
  fi
}

install_packages() {
  local missing=()
  for command in Xvfb x11vnc openbox websockify; do
    if ! command -v "$command" >/dev/null 2>&1; then
      missing+=("$command")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Installing temporary remote-login packages..."
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb x11vnc openbox novnc websockify
  fi
}

host_name() {
  hostname -f 2>/dev/null || hostname
}

start_login() {
  need_root "$@"
  local service_group
  service_group="$(id -gn "$SERVICE_USER")"
  if systemctl is-active --quiet vine-watcher.service; then
    echo "Stopping vine-watcher.service so Chromium can use the persistent profile safely..."
    systemctl stop vine-watcher.service
  fi
  install_packages
  mkdir -p "$RUN_DIR"
  chown "$SERVICE_USER:$service_group" "$RUN_DIR"
  stop_processes
  rm -f "${RUN_DIR}"/*.log "$DONE_FILE"
  create_vnc_password

  runuser -u "$SERVICE_USER" -- x11vnc -storepasswd "$VNC_PASSWORD" "$PASS_FILE" >/dev/null 2>&1
  chmod 600 "$PASS_FILE"
  chown "$SERVICE_USER:$service_group" "$PASS_FILE"

  runuser -u "$SERVICE_USER" -- sh -c "nohup Xvfb $DISPLAY_ID -screen 0 1365x900x24 -nolisten tcp >$RUN_DIR/xvfb.log 2>&1 & echo \$! >$RUN_DIR/xvfb.pid"
  sleep 1
  runuser -u "$SERVICE_USER" -- sh -c "DISPLAY=$DISPLAY_ID nohup openbox >$RUN_DIR/openbox.log 2>&1 & echo \$! >$RUN_DIR/openbox.pid"
  runuser -u "$SERVICE_USER" -- sh -c "DISPLAY=$DISPLAY_ID nohup x11vnc -display $DISPLAY_ID -rfbauth $PASS_FILE -forever -shared -rfbport $VNC_PORT -listen 0.0.0.0 >$RUN_DIR/x11vnc.log 2>&1 & echo \$! >$RUN_DIR/x11vnc.pid"

  local novnc_web="/usr/share/novnc"
  if [ ! -d "$novnc_web" ]; then
    novnc_web="/usr/share/novnc/html"
  fi
  runuser -u "$SERVICE_USER" -- sh -c "nohup websockify --web=$novnc_web 0.0.0.0:$NOVNC_PORT localhost:$VNC_PORT >$RUN_DIR/novnc.log 2>&1 & echo \$! >$RUN_DIR/novnc.pid"
  sleep 1
  runuser -u "$SERVICE_USER" -- sh -c "cd $APP_DIR && DISPLAY=$DISPLAY_ID HOME=/var/lib/$SERVICE_USER nohup npm run login:server >$RUN_DIR/login.log 2>&1 & echo \$! >$RUN_DIR/login.pid"

  local host
  host="$(host_name)"
  echo
  echo "Temporary browser login is running."
  echo "Open: http://${host}:${NOVNC_PORT}/vnc.html?host=${host}&port=${NOVNC_PORT}"
  echo "Password: ${VNC_PASSWORD}"
  echo
  echo "After Amazon Vine is visible and logged in, run:"
  echo "  sudo ${APP_DIR}/scripts/server-login.sh finish"
}

finish_login() {
  need_root "$@"
  local service_group
  service_group="$(id -gn "$SERVICE_USER")"
  touch "$DONE_FILE"
  chown "$SERVICE_USER:$service_group" "$DONE_FILE"
  echo "Closing Chromium cleanly and saving the persistent profile..."
  sleep 6
  tail -n 20 "$RUN_DIR/login.log" 2>/dev/null || true
  stop_processes
  echo "Login session closed."
}

status_login() {
  for name in login novnc x11vnc openbox xvfb; do
    local pidfile="${RUN_DIR}/${name}.pid"
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "$name: running"
    else
      echo "$name: stopped"
    fi
  done
}

case "${1:-}" in
  start)
    start_login "$@"
    ;;
  finish)
    finish_login "$@"
    ;;
  stop)
    need_root "$@"
    stop_processes
    echo "Temporary login session stopped."
    ;;
  status)
    status_login
    ;;
  *)
    echo "Usage: sudo $0 {start|finish|stop|status}"
    exit 1
    ;;
esac
