#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vine-watcher-telegram}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
SERVICE_NAME="${SERVICE_NAME:-vine-watcher.service}"

usage() {
  cat <<EOF
Usage:
  sudo $0 on [minutes] [interval_seconds] [jitter_seconds]
  sudo $0 off
  sudo $0 status

Examples:
  sudo $0 on 30
  sudo $0 on 15 10 3
  sudo $0 off
EOF
}

ensure_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "Missing env file: $ENV_FILE" >&2
    exit 1
  fi
}

escape_sed_replacement() {
  printf "%s" "$1" | sed 's/[\/&]/\\&/g'
}

set_env() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(escape_sed_replacement "$value")"

  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s/^${key}=.*/${key}=${escaped}/" "$ENV_FILE"
  else
    printf "\n%s=%s\n" "$key" "$value" >> "$ENV_FILE"
  fi
}

read_env() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

utc_after_minutes() {
  local minutes="$1"
  if date -u -d "+${minutes} minutes" +"%Y-%m-%dT%H:%M:%SZ" >/dev/null 2>&1; then
    date -u -d "+${minutes} minutes" +"%Y-%m-%dT%H:%M:%SZ"
    return
  fi

  python3 - "$minutes" <<'PY'
from datetime import datetime, timedelta, timezone
import sys

minutes = int(sys.argv[1])
until = datetime.now(timezone.utc) + timedelta(minutes=minutes)
print(until.replace(microsecond=0).isoformat().replace("+00:00", "Z"))
PY
}

restart_service() {
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$SERVICE_NAME" >/dev/null 2>&1; then
    systemctl restart "$SERVICE_NAME"
    echo "Restarted ${SERVICE_NAME}."
  else
    echo "Restart the watcher service to apply changes."
  fi
}

panic_on() {
  ensure_env_file
  local minutes="${1:-30}"
  local interval="${2:-10}"
  local jitter="${3:-3}"
  local until
  until="$(utc_after_minutes "$minutes")"

  set_env PANIC_MODE false
  set_env PANIC_UNTIL "$until"
  set_env PANIC_SCAN_INTERVAL_SECONDS "$interval"
  set_env PANIC_SCAN_JITTER_SECONDS "$jitter"

  echo "Panic mode enabled until ${until}."
  echo "Interval: ${interval}s + 0-${jitter}s jitter."
  restart_service
}

panic_off() {
  ensure_env_file
  set_env PANIC_MODE false
  set_env PANIC_UNTIL ""
  echo "Panic mode disabled."
  restart_service
}

panic_status() {
  ensure_env_file
  echo "PANIC_MODE=$(read_env PANIC_MODE)"
  echo "PANIC_UNTIL=$(read_env PANIC_UNTIL)"
  echo "PANIC_SCAN_INTERVAL_SECONDS=$(read_env PANIC_SCAN_INTERVAL_SECONDS)"
  echo "PANIC_SCAN_JITTER_SECONDS=$(read_env PANIC_SCAN_JITTER_SECONDS)"
}

case "${1:-}" in
  on)
    shift
    panic_on "$@"
    ;;
  off)
    panic_off
    ;;
  status)
    panic_status
    ;;
  *)
    usage
    exit 1
    ;;
esac
