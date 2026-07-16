#!/usr/bin/env bash
set -euo pipefail

DONE_FILE="${LOGIN_WAIT_FILE:-/tmp/vine-watcher-login/done}"
docker compose --profile login exec -e LOGIN_WAIT_FILE="$DONE_FILE" login sh -lc \
  'mkdir -p "$(dirname "$LOGIN_WAIT_FILE")" && touch "$LOGIN_WAIT_FILE"'
