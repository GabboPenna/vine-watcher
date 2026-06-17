#!/usr/bin/env bash
set -euo pipefail

cd "${APP_DIR:-/opt/vine-watcher-telegram}"

if [ "${VINE_WATCHER_XVFB:-false}" = "true" ]; then
  exec xvfb-run -a --server-args="-screen 0 1365x900x24 -nolisten tcp" npm run start
fi

exec npm run start
