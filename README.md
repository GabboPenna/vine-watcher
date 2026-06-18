# Vine Watcher

[![CI](https://github.com/GabboPenna/vine-watcher/actions/workflows/ci.yml/badge.svg)](https://github.com/GabboPenna/vine-watcher/actions/workflows/ci.yml)
[![Docker](https://github.com/GabboPenna/vine-watcher/actions/workflows/docker.yml/badge.svg)](https://github.com/GabboPenna/vine-watcher/actions/workflows/docker.yml)

Local Amazon Vine watcher with Telegram notifications.

Vine Watcher monitors the Amazon Vine sections already available to your logged-in account and sends Telegram alerts when a newly seen product looks interesting. It is a read-only notification service, not an ordering bot.

## What It Does

- Watches configured Amazon Vine queues with Playwright and Chromium.
- Stores seen products in SQLite to avoid duplicate alerts.
- Scores products with keyword, brand, category, and negative-signal rules.
- Sends Telegram notifications with score, reasons, ASIN, image when available, and the Vine section URL.
- Supports estimated-value alerts when the visible Vine card exposes a value.
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
MIN_SCORE_TO_NOTIFY=20
MIN_VALUE_TO_NOTIFY_EUR=50
NOTIFY_ALL_PRODUCTS=false
STRICT_NOTIFY_MODE=true
MAX_NOTIFICATIONS_PER_CYCLE=5
STOP_ON_SESSION_ATTENTION=true
```

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

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

Release tags are published from semver Git tags such as `v0.2.0`.

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
