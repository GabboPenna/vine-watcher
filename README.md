# Vine Watcher

[![CI](https://github.com/GabboPenna/vine-watcher/actions/workflows/ci.yml/badge.svg)](https://github.com/GabboPenna/vine-watcher/actions/workflows/ci.yml)
[![Docker](https://github.com/GabboPenna/vine-watcher/actions/workflows/docker.yml/badge.svg)](https://github.com/GabboPenna/vine-watcher/actions/workflows/docker.yml)

Local Amazon Vine watcher with Telegram notifications.

Vine Watcher monitors the Amazon Vine sections already available to your logged-in account and sends Telegram alerts when a newly seen product looks interesting. It is a read-only notification service, not an ordering bot.

## What It Does

- Watches configured Amazon Vine queues with Playwright and Chromium.
- Stores seen products in SQLite to avoid duplicate alerts.
- Tracks current inventory state: present, disappeared, and reappeared products.
- Scores products with keyword, brand, category, and negative-signal rules.
- Can load extra scoring keywords from JSON or simple YAML files.
- Sends compact Telegram notifications with score, estimated Vine value, grouped reasons, ASIN, image when available, and an inline Vine section button.
- Sends matching notifications immediately when possible, then edits the Telegram message if a later Vine detail lookup finds the estimated value.
- Can be controlled from Telegram with an optional private command interface.
- Supports estimated-value alerts from the Vine card or the read-only Vine detail tax value.
- Stores notification decisions, triggers, blockers, and a safe config snapshot for debugging.
- Includes dry-run scans, layout-health warnings, SQLite retention, and a local read-only health API.
- Can scan sections in parallel and reuse Chromium tabs for lower notification latency.
- Runs on Debian with systemd or with Docker Compose.
- Uses a persistent Chromium profile created by manual login.
- Uses headed Chromium inside a virtual display for the systemd service to reduce false Amazon login redirects.

## Safety

Vine Watcher is intentionally read-only.

- It never requests Vine products.
- It never clicks request, order, submit, details, checkout, or equivalent buttons.
- It never bypasses CAPTCHA, login, rate limits, or Amazon security controls.
- It never stores your Amazon password.
- It does not export or manipulate cookies explicitly.
- You always decide manually whether to open Vine and request a product.

Read the full policy in [docs/SAFETY.md](docs/SAFETY.md).

## Quick Start

### Debian

```bash
git clone https://github.com/GabboPenna/vine-watcher.git
cd vine-watcher
sudo bash scripts/install-debian.sh
```

The installer guides package installation, `.env` creation, Telegram testing, systemd setup, and the manual Amazon login step.

Detailed guide: [docs/INSTALL_DEBIAN.md](docs/INSTALL_DEBIAN.md)

### Docker Compose

```bash
git clone https://github.com/GabboPenna/vine-watcher.git
cd vine-watcher
cp .env.example .env
nano .env
docker compose up -d watcher
```

For first login, stop the watcher and use the temporary noVNC helper:

```bash
docker compose stop watcher
docker compose --profile login up login
```

Detailed guide: [docs/DOCKER.md](docs/DOCKER.md)

## Configuration

Start from:

```bash
cp .env.example .env
```

Important defaults:

```bash
SCAN_INTERVAL_SECONDS=30
SCAN_JITTER_SECONDS=10
ADAPTIVE_SCAN_ENABLED=false
SECTION_HARD_TIMEOUT_SECONDS=0
SECTION_SCAN_CONCURRENCY=1
REUSE_SECTION_PAGES=false
DETAIL_VALUE_LOOKUP_ENABLED=true
DETAIL_VALUE_LOOKUP_MAX_PER_CYCLE=10
DETAIL_VALUE_LOOKUP_TIMEOUT_SECONDS=4
SCANNER_TURBO_ONLY_DURING_ADAPTIVE_ACTIVE=false
MIN_SCORE_TO_NOTIFY=20
MIN_VALUE_TO_NOTIFY_EUR=50
NOTIFY_ALL_PRODUCTS=false
NOTIFY_ALL_PRODUCTS_WINDOW=
STRICT_NOTIFY_MODE=true
MAX_NOTIFICATIONS_PER_CYCLE=5
STOP_ON_SESSION_ATTENTION=true
HEALTH_SERVER_ENABLED=false
TELEGRAM_CONTROL_ENABLED=false
```

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## Telegram Control

Enable the optional command interface:

```bash
TELEGRAM_CONTROL_ENABLED=true
TELEGRAM_CONTROL_LANGUAGE=en
```

Only messages from the configured `TELEGRAM_CHAT_ID` are accepted. No inbound port, webhook, reverse proxy, or firewall rule is required.

Useful commands:

```text
/menu                         open the button control panel
/help                         show the full command guide
/lang it|en                   switch bot language
/status                       live status and last scan summary
/config                       effective config and runtime overrides
/dashboard                    quick watcher dashboard
/latest 10                    latest seen products
/latest present 10            products still visible on Vine
/why text                     explain why a saved product was notified or ignored
/replay text 3                resend already seen products
/replay present 20            resend products visible right now
/profile balanced             apply conservative, balanced, drop, or notify-all presets
/notify_all on|off            notify every product
/notify_all always            notify every product 24/7 and clear the notify-all window
/notify_all_window 09:00-22:30 schedule notify-all mode
/min_score 5                  change score threshold
/min_value 35                 change estimated value threshold
/strict on|off                toggle strict filtering
/adaptive on|off              toggle adaptive scan scheduling
/adaptive 4 45 4 12 2        tune adaptive idle/active timings
/panic 30                     fast scan mode for 30 minutes
/fast on|off                  fast or conservative profile
/reset all                    clear runtime overrides
```

When Telegram Control starts it also registers the bot command menu, so Telegram clients can show native commands from the chat menu. `/menu` sends an inline button panel for the common actions.

Diagnostic commands use the local SQLite history:

- `/why maschera` explains the most recent matching saved product, including score, triggers, blockers, and notification state.
- `/latest present 10` shows products that are still visible on Vine. Modes: `all`, `notified`, `unnotified`, `ignored`, `present`, `gone`, `reappeared`, or `top`.
- `/replay bosch 3` manually resends saved products to Telegram and marks them as notified.
- `/replay present 20` resends the products currently visible on Vine, useful when notify-all is enabled after products were already saved.
- `/dashboard` summarizes stored products, recent cycles, and memory guard status.

## Diagnostics And Health

Each saved product keeps the latest scoring decision: score, reasons, triggers, blockers, first score, present/gone/reappeared state, and a safe runtime config snapshot.

Use dry-run mode to inspect what would be notified without sending Telegram messages:

```bash
npm run dry-run:once
```

Enable the local read-only health API when you want Home Assistant, Prometheus, or a simple curl check:

```bash
HEALTH_SERVER_ENABLED=true
HEALTH_SERVER_HOST=127.0.0.1
HEALTH_SERVER_PORT=8765
HEALTH_SERVER_TOKEN=change-me
```

Endpoints:

```text
/health
/metrics
/last-cycle
/latest-products?mode=present&limit=20
```

## Runtime Notes

The Debian systemd service uses `scripts/run-service.sh`, which can run Chromium in headed mode inside Xvfb:

```text
systemd -> scripts/run-service.sh -> xvfb-run -> npm run start
```

This keeps the service headless from the server point of view while making Chromium behave more like the browser used during manual login.

Docker uses the same runtime wrapper for the watcher service, so Debian and Docker follow the same startup path.

## Commands

```bash
npm run start                # continuous watcher
npm run once                 # one scan, then exit
npm run dry-run:once         # one scan without sending Telegram notifications
npm run login                # local visible Chromium login
npm run test:telegram        # send Telegram test message
npm run stats                # show SQLite stats
npm run export:csv           # export products to CSV
npm run validate             # syntax, bash, tests, secret hygiene
npm run docker:up            # start Docker watcher
npm run docker:login         # start Docker noVNC login helper
```

## Docker Images

Published image:

```bash
docker pull gabrielepennacchia/vine-watcher:latest
```

Release tags are published from semver Git tags such as `v0.6.2`.

## Project Layout

```text
src/                  application code
scripts/              operational, install, login, and validation tools
systemd/              systemd unit
docs/                 product documentation
.github/workflows/    CI and Docker image publishing
```

## Troubleshooting

Start here: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

Useful commands:

```bash
journalctl -u vine-watcher.service -f
systemctl status vine-watcher.service
npm run stats
```

## Contributing

Issues and pull requests are welcome. Please keep the read-only safety policy intact.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
