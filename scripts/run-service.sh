#!/usr/bin/env bash
set -euo pipefail

cd "${APP_DIR:-/opt/vine-watcher-telegram}"

if [ "${VINE_WATCHER_XVFB:-false}" = "true" ]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "VINE_WATCHER_XVFB=true but xvfb-run is not installed." >&2
    exit 1
  fi
  exec xvfb-run -a --server-args="-screen 0 1365x900x24 -nolisten tcp" npm run start
fi

exec npm run start
