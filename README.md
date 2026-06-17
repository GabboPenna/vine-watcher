# Vine Watcher Telegram

Local Amazon Vine monitor with Telegram notifications.

Vine Watcher Telegram watches the Amazon Vine pages that are already available to your logged-in account and notifies you when a newly seen product looks interesting. It is a notification system, not an ordering bot.

## Safety Policy

This project is intentionally read-only.

- It never requests Vine products.
- It never clicks request, order, submit, details, checkout, or equivalent buttons.
- It never bypasses CAPTCHA, login, rate limits, or Amazon security controls.
- It never stores your Amazon password.
- It does not read, export, or manipulate cookies explicitly.
- It uses a local persistent Chromium profile that you create manually.
- It only opens configured Vine section URLs and reads product cards from the page DOM.
- You always decide manually whether to open Vine and request a product.

If Amazon asks for login, 2FA, CAPTCHA, or any manual verification, the watcher stops that scan and logs a clear message.

## Features

- Playwright + Chromium persistent profile.
- SQLite database of seen products.
- Telegram Bot API notifications.
- Keyword and brand scoring tuned for smart home, tools, electronics, and useful household items.
- Duplicate detection by ASIN, URL, or normalized title.
- Anti-spam limit per scan cycle.
- Optional critical-error Telegram alerts.
- Systemd service example.
- Guided Debian installer.
- Temporary noVNC helper for Amazon login on headless servers.
- CSV export and local stats command.

## Notification Behavior

Telegram notifications link to the **Vine section URL**, not the public Amazon product page. This is deliberate: when a good item appears, opening the Vine queue is usually faster than landing on the normal product detail page.

Each message includes:

- score
- Vine section
- product title
- scoring reasons
- Vine section link
- ASIN, when available

If an image URL is available, the watcher sends a Telegram photo with the same caption. If photo sending fails, it falls back to a text message.

## Requirements

- Debian 12/13 or similar
- Node.js 20+
- Playwright Chromium
- SQLite
- Telegram bot token and chat id
- Amazon Vine account, logged in manually through the persistent browser profile

## Quick Install on Debian

Clone the repository on the target machine:

```bash
git clone https://github.com/GabboPenna/vine-watcher.git
cd vine-watcher
sudo bash scripts/install-debian.sh
```

The installer guides you through:

- Debian package installation
- Node.js check/install
- service user creation
- npm dependencies
- Playwright Chromium install
- `.env` creation
- Telegram test
- systemd service installation

The installer does not ask for your Amazon password. Amazon login is always manual.

## Manual Install

```bash
sudo apt update
sudo apt install -y ca-certificates curl git sqlite3 nodejs npm build-essential python3

sudo useradd --system --create-home --home-dir /var/lib/vinewatcher --shell /usr/sbin/nologin vinewatcher
sudo mkdir -p /opt/vine-watcher-telegram
sudo chown -R vinewatcher:vinewatcher /opt/vine-watcher-telegram /var/lib/vinewatcher

sudo cp -a . /opt/vine-watcher-telegram/
cd /opt/vine-watcher-telegram

sudo -u vinewatcher npm install
sudo npx playwright install-deps chromium
sudo -u vinewatcher -H npx playwright install chromium

sudo cp .env.example .env
sudo nano .env
sudo chown vinewatcher:vinewatcher .env
sudo chmod 600 .env
```

## Configuration

Main `.env` values:

```bash
TELEGRAM_BOT_TOKEN=123456:ABCDEF
TELEGRAM_CHAT_ID=123456789
AMAZON_VINE_BASE_URL=https://www.amazon.it/vine/vine-items
SCAN_INTERVAL_SECONDS=30
SCAN_JITTER_SECONDS=10
MIN_SCORE_TO_NOTIFY=15
MAX_NOTIFICATIONS_PER_CYCLE=5
HEADLESS=true
DATABASE_PATH=./data/vine-watcher.sqlite
PLAYWRIGHT_USER_DATA_DIR=./data/chromium-profile
NOTIFY_CRITICAL_ERRORS=true
```

Default sections:

- `Recommended for you`: `queue=potluck`
- `Additional items`: `queue=encore`
- `All items`: `queue=last_chance`, disabled unless `SCAN_ALL_ITEMS=true`

Add custom sections:

```bash
EXTRA_SECTIONS_JSON=[{"name":"Zigbee search","url":"https://www.amazon.it/vine/vine-items?queue=encore&search=zigbee","enabled":true}]
```

Or fully override the section list:

```bash
SECTIONS_JSON=[{"name":"Only recommended","url":"https://www.amazon.it/vine/vine-items?queue=potluck","enabled":true}]
```

## Telegram Setup

1. Open Telegram and start a chat with `BotFather`.
2. Create a bot with `/newbot`.
3. Copy the token into `TELEGRAM_BOT_TOKEN`.
4. Send at least one message to your bot.
5. Get the chat id:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Look for `chat.id` in the response and put it into `TELEGRAM_CHAT_ID`.

Never commit `.env` or paste production tokens into public issues.

Test Telegram:

```bash
cd /opt/vine-watcher-telegram
sudo -u vinewatcher -H npm run test:telegram
```

## Amazon Login

The watcher needs a persistent local Chromium profile. Create it manually before starting the service.

### Desktop or SSH X Forwarding

```bash
cd /opt/vine-watcher-telegram
sudo -u vinewatcher -H npm run login
```

Complete login, 2FA, or verification in Chromium. When Vine is visible and stable, press Enter in the terminal.

### Headless Server with noVNC

Start a temporary browser login session:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh start
```

Open the printed noVNC URL, enter the printed password, and complete Amazon login manually. When Vine is visible and stable, close it cleanly:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh finish
```

Stop the temporary session without saving:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh stop
```

## First Scan

Run one scan before enabling continuous monitoring:

```bash
cd /opt/vine-watcher-telegram
sudo -u vinewatcher -H npm run once
```

Expected success log:

```text
Section "Recommended for you" scanned: N product candidates
Section "Additional items" scanned: N product candidates
Cycle complete: scanned=N new=N notified=N max_score=N
```

If login is required, rerun the Amazon login step. The watcher will not bypass it.

## Systemd

Install and start:

```bash
sudo cp /opt/vine-watcher-telegram/systemd/vine-watcher.service /etc/systemd/system/vine-watcher.service
sudo systemctl daemon-reload
sudo systemctl enable --now vine-watcher.service
```

Logs:

```bash
journalctl -u vine-watcher.service -f
```

Status:

```bash
systemctl status vine-watcher.service
```

Stop:

```bash
sudo systemctl stop vine-watcher.service
```

## npm Commands

```bash
npm run login              # visible Chromium login
npm run login:wait         # visible Chromium login, auto-close after 15 minutes
npm run login:server       # waits for /tmp/vine-watcher-login/done
npm run once               # one scan, then exit
npm run start              # continuous loop
npm run test:telegram      # send a Telegram test message
npm run stats              # show SQLite stats
npm run export:csv         # export seen products to CSV
```

## Scoring

Keyword lists live in `src/config.js`.

Rules:

- `+10` for each high-priority keyword
- `+5` for each normal keyword
- `-10` for each negative keyword
- `+8` for each known brand
- `+5` smart-home bonus
- `+5` electronics/tool bonus
- `-5` generic-accessory malus
- `-10` replacement/niche-item malus

The score result includes a `reasons` array, saved as `reasons_json` in SQLite and shown in Telegram messages.

## SQLite

The database is created automatically at `DATABASE_PATH`.

`products` columns:

- `id`
- `asin`
- `title`
- `normalized_title`
- `url`
- `section_url`
- `image_url`
- `section`
- `first_seen_at`
- `last_seen_at`
- `score`
- `reasons_json`
- `notified`
- `raw_text`

A product is treated as already seen when at least one of these matches:

- ASIN
- canonical product URL
- normalized title

## Maintenance

Amazon can change the Vine DOM. If extraction breaks, start by checking the selector block in `src/scanner.js`:

- `productSelectors`
- `cardSelector`
- `titleSelectors`

The scanner does not contain click, fill, submit, checkout, or request-product actions.

## Troubleshooting

### Telegram works, but no Vine products are found

Run:

```bash
sudo -u vinewatcher -H npm run once
```

If it says login is required, refresh the Chromium profile with the Amazon login flow.

### Service starts but Amazon asks for login again

Run:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh start
```

Complete login manually, then:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh finish
sudo systemctl restart vine-watcher.service
```

### Too many notifications

Raise:

```bash
MIN_SCORE_TO_NOTIFY=25
MAX_NOTIFICATIONS_PER_CYCLE=3
```

Then restart:

```bash
sudo systemctl restart vine-watcher.service
```

### Need to inspect seen products

```bash
cd /opt/vine-watcher-telegram
sudo -u vinewatcher -H npm run stats
sudo -u vinewatcher -H npm run export:csv
```

## Contributing

Issues and pull requests are welcome.

Please keep the safety policy intact:

- no auto-requesting
- no checkout automation
- no CAPTCHA bypass
- no cookie export/import helpers
- no credential storage

Good contributions include:

- safer selectors
- better scoring defaults
- more deployment docs
- improved install UX
- tests for parsing/scoring/storage

## License

MIT
