#!/usr/bin/env bash
set -euo pipefail

APP_NAME="vine-watcher-telegram"
INSTALL_DIR="${INSTALL_DIR:-/opt/vine-watcher-telegram}"
SERVICE_USER="${SERVICE_USER:-vinewatcher}"
NODE_MAJOR_MIN=20

say() {
  printf "\n==> %s\n" "$1"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

prompt() {
  local label="$1"
  local default_value="${2:-}"
  local value
  if [ -n "$default_value" ]; then
    read -r -p "$label [$default_value]: " value
    printf "%s" "${value:-$default_value}"
  else
    read -r -p "$label: " value
    printf "%s" "$value"
  fi
}

prompt_secret() {
  local label="$1"
  local value
  read -r -s -p "$label: " value
  echo
  printf "%s" "$value"
}

yes_no() {
  local label="$1"
  local default="${2:-Y}"
  local answer
  read -r -p "$label [$default]: " answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy] ]]
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "Run this installer as root: sudo bash scripts/install-debian.sh"
  fi
}

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

install_base_packages() {
  say "Installing Debian packages"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl git sqlite3 nodejs npm build-essential python3 xvfb xauth
}

ensure_node() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge "$NODE_MAJOR_MIN" ]; then
    echo "Node.js $(node --version) is ready."
    return
  fi

  say "Installing Node.js LTS from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$NODE_MAJOR_MIN" ] || die "Node.js >= ${NODE_MAJOR_MIN} is required."
}

create_user() {
  say "Creating service user"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "/var/lib/${SERVICE_USER}" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
}

copy_project() {
  local source_dir
  source_dir="$(repo_root)"

  say "Installing project into ${INSTALL_DIR}"
  mkdir -p "$INSTALL_DIR"
  tar \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.env' \
    --exclude='data/chromium-profile' \
    --exclude='data/*.sqlite' \
    --exclude='data/*.sqlite-*' \
    -C "$source_dir" -cf - . | tar -C "$INSTALL_DIR" -xf -
  chmod 755 "${INSTALL_DIR}/scripts/"*.sh
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" "/var/lib/${SERVICE_USER}"
}

install_node_dependencies() {
  say "Installing npm dependencies"
  cd "$INSTALL_DIR"
  runuser -u "$SERVICE_USER" -- npm install --loglevel=error
}

install_playwright() {
  say "Installing Playwright Chromium and OS dependencies"
  cd "$INSTALL_DIR"
  npx playwright install-deps chromium
  runuser -u "$SERVICE_USER" -- env HOME="/var/lib/${SERVICE_USER}" npx playwright install chromium
}

write_env() {
  say "Guided configuration"
  local env_file="${INSTALL_DIR}/.env"
  if [ -f "$env_file" ] && ! yes_no ".env already exists. Replace it?" "N"; then
    echo "Keeping existing .env."
    return
  fi

  local telegram_token telegram_chat_id vine_url scan_interval scan_jitter min_score min_value strict_mode max_notifications headless notify_errors
  telegram_token="$(prompt_secret "Telegram bot token")"
  telegram_chat_id="$(prompt "Telegram chat id")"
  vine_url="$(prompt "Amazon Vine base URL" "https://www.amazon.it/vine/vine-items")"
  scan_interval="$(prompt "Scan interval in seconds" "60")"
  scan_jitter="$(prompt "Random jitter in seconds" "15")"
  min_score="$(prompt "Minimum score to notify" "20")"
  min_value="$(prompt "Always notify when estimated value is at least EUR" "50")"
  strict_mode="$(prompt "Use stricter score filtering? true/false" "true")"
  max_notifications="$(prompt "Maximum notifications per scan" "5")"
  headless="$(prompt "Run Chromium headless after login? true/false" "true")"
  notify_errors="$(prompt "Notify critical errors on Telegram? true/false" "true")"

  umask 077
  cat > "$env_file" <<EOF
TELEGRAM_BOT_TOKEN=${telegram_token}
TELEGRAM_CHAT_ID=${telegram_chat_id}
AMAZON_VINE_BASE_URL=${vine_url}
SCAN_ALL_ITEMS=false
SCAN_INTERVAL_SECONDS=${scan_interval}
SCAN_JITTER_SECONDS=${scan_jitter}
PANIC_MODE=false
PANIC_UNTIL=
PANIC_SCAN_INTERVAL_SECONDS=10
PANIC_SCAN_JITTER_SECONDS=3
MIN_SCORE_TO_NOTIFY=${min_score}
MIN_VALUE_TO_NOTIFY_EUR=${min_value}
STRICT_NOTIFY_MODE=${strict_mode}
STRICT_MIN_POSITIVE_SIGNALS=2
STRICT_MAX_NEGATIVE_SIGNALS=0
MAX_NOTIFICATIONS_PER_CYCLE=${max_notifications}
HEADLESS=${headless}
CHROMIUM_NO_SANDBOX=false
PAGE_TIMEOUT_SECONDS=45
WAIT_FOR_NETWORK_IDLE=false
PRODUCT_READY_TIMEOUT_SECONDS=5
PAGE_SETTLE_SECONDS=1
SECTION_DELAY_SECONDS=1
BLOCK_RESOURCE_TYPES=font,media
LOG_LEVEL=info
DATABASE_PATH=./data/vine-watcher.sqlite
PLAYWRIGHT_USER_DATA_DIR=./data/chromium-profile
NOTIFY_CRITICAL_ERRORS=${notify_errors}
CRITICAL_NOTIFICATION_COOLDOWN_SECONDS=900
SESSION_ATTENTION_MAX_FAILURES=2
SESSION_ATTENTION_COOLDOWN_SECONDS=300
VERIFY_SESSION_ATTENTION=true
SESSION_ATTENTION_GRACE_SECONDS=300
SESSION_FAILURE_BACKOFF_SECONDS=90
STOP_ON_SESSION_ATTENTION=true
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$env_file"
  chmod 600 "$env_file"
}

install_service() {
  say "Installing systemd service"
  install -o root -g root -m 0644 "${INSTALL_DIR}/systemd/vine-watcher.service" /etc/systemd/system/vine-watcher.service
  systemctl daemon-reload
  if yes_no "Enable the service at boot?" "Y"; then
    systemctl enable vine-watcher.service
  fi
}

final_steps() {
  say "Smoke tests"
  cd "$INSTALL_DIR"
  runuser -u "$SERVICE_USER" -- env HOME="/var/lib/${SERVICE_USER}" npm run stats
  if yes_no "Send a Telegram test message now?" "Y"; then
    runuser -u "$SERVICE_USER" -- env HOME="/var/lib/${SERVICE_USER}" npm run test:telegram
  fi

  say "Amazon login"
  echo "Before starting the service, create the persistent Amazon browser profile."
  echo
  echo "Desktop or SSH X-forwarding login:"
  echo "  cd ${INSTALL_DIR}"
  echo "  sudo -u ${SERVICE_USER} -H npm run login"
  echo
  echo "Headless server login with temporary noVNC:"
  echo "  sudo ${INSTALL_DIR}/scripts/server-login.sh start"
  echo "  # open the printed URL, complete Amazon login"
  echo "  sudo ${INSTALL_DIR}/scripts/server-login.sh finish"
  echo
  echo "Then run one scan and start the service:"
  echo "  cd ${INSTALL_DIR}"
  echo "  sudo -u ${SERVICE_USER} -H npm run once"
  echo "  sudo systemctl start vine-watcher.service"
  echo "  journalctl -u vine-watcher.service -f"
}

main() {
  require_root
  install_base_packages
  ensure_node
  create_user
  copy_project
  install_node_dependencies
  install_playwright
  write_env
  install_service
  final_steps
}

main "$@"
