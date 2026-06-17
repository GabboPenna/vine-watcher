# Vine Watcher Telegram

[![CI](https://github.com/GabboPenna/vine-watcher/actions/workflows/ci.yml/badge.svg)](https://github.com/GabboPenna/vine-watcher/actions/workflows/ci.yml)

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
- Estimated-value override for products whose visible Vine card shows a value above your threshold.
- Optional strict notification filter to reduce noisy alerts.
- Temporary panic mode for short, aggressive scan windows.
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
- notification trigger
- estimated value, when visible in the Vine card
- Vine section link
- ASIN, when available

If an image URL is available, the watcher sends a Telegram photo with the same caption. If photo sending fails, it falls back to a text message.

The value override is read-only and only uses prices or values already visible in the Vine card. The watcher does not click product details to discover hidden prices.

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
PANIC_MODE=false
PANIC_UNTIL=
PANIC_SCAN_INTERVAL_SECONDS=10
PANIC_SCAN_JITTER_SECONDS=3
MIN_SCORE_TO_NOTIFY=20
MIN_VALUE_TO_NOTIFY_EUR=50
STRICT_NOTIFY_MODE=true
STRICT_MIN_POSITIVE_SIGNALS=2
STRICT_MAX_NEGATIVE_SIGNALS=0
MAX_NOTIFICATIONS_PER_CYCLE=5
HEADLESS=true
WAIT_FOR_NETWORK_IDLE=false
PRODUCT_READY_TIMEOUT_SECONDS=5
BLOCK_RESOURCE_TYPES=font,media
DATABASE_PATH=./data/vine-watcher.sqlite
PLAYWRIGHT_USER_DATA_DIR=./data/chromium-profile
NOTIFY_CRITICAL_ERRORS=true
SESSION_ATTENTION_MAX_FAILURES=2
SESSION_ATTENTION_COOLDOWN_SECONDS=300
STOP_ON_SESSION_ATTENTION=true
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

The noVNC password is generated for that temporary session and removed when you run `finish` or `stop`. You can override it with `VNC_PASSWORD=...` if you really need to, but do not commit real passwords.

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

## Panic Mode

Panic mode temporarily lowers the wait between scan cycles. It is useful when you are actively watching Vine and want faster alerts for a short window.

Enable 30 minutes of panic mode:

```bash
sudo /opt/vine-watcher-telegram/scripts/panic.sh on 30
```

Enable 15 minutes with a 10-second base interval and up to 3 seconds of jitter:

```bash
sudo /opt/vine-watcher-telegram/scripts/panic.sh on 15 10 3
```

Check or disable it:

```bash
sudo /opt/vine-watcher-telegram/scripts/panic.sh status
sudo /opt/vine-watcher-telegram/scripts/panic.sh off
```

Panic mode updates `.env` and restarts the systemd service.

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

The service uses `Restart=on-failure`. When Amazon requires login, CAPTCHA, or manual verification, the watcher can stop cleanly after repeated session-health failures instead of restarting forever.

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
npm run validate           # syntax, shell, core tests, and secret hygiene
npm test                   # core unit tests
npm run test:telegram      # send a Telegram test message
npm run stats              # show SQLite stats
npm run export:csv         # export seen products to CSV
npm run panic:status       # show panic settings
```

## Quality Gates

GitHub Actions runs the validation suite on every push to `main`, every pull request, and manual workflow dispatch.

The CI checks:

- clean dependency install with `npm ci`
- JavaScript syntax with `node --check`
- Bash syntax for install/login/panic scripts
- core unit tests for scoring, value parsing, notification triggers, storage, and Telegram formatting
- secret hygiene for tracked files, including Telegram tokens, private keys, Amazon cookies, runtime `.env` files, and SQLite data

Run the same suite locally:

```bash
npm run validate
```

## Session Health

When Amazon asks for login, 2FA, CAPTCHA, or another manual check, the watcher treats it as a session-health failure.

Default behavior:

- notify Telegram immediately, then at most once every `SESSION_ATTENTION_COOLDOWN_SECONDS`
- stop after `SESSION_ATTENTION_MAX_FAILURES` consecutive failures
- exit cleanly so systemd does not restart it in a loop

After you complete manual login, start the service again:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh start
# complete Amazon login in noVNC
sudo /opt/vine-watcher-telegram/scripts/server-login.sh finish
sudo systemctl start vine-watcher.service
```

To keep retrying instead of stopping, set:

```bash
STOP_ON_SESSION_ATTENTION=false
```

## Scanner Performance

The scanner is optimized to read Vine cards as soon as the DOM is usable:

- `WAIT_FOR_NETWORK_IDLE=false` avoids waiting for Amazon tracking/lazy-load requests.
- `PRODUCT_READY_TIMEOUT_SECONDS=5` waits briefly for Vine cards or login/CAPTCHA signals.
- `PAGE_SETTLE_SECONDS=1` keeps a short post-load buffer.
- `SECTION_DELAY_SECONDS=1` keeps section-to-section scans quick.
- `BLOCK_RESOURCE_TYPES=font,media` blocks heavy nonessential browser resources.

If Amazon changes the page and extraction becomes flaky, temporarily increase `PAGE_SETTLE_SECONDS` or set `WAIT_FOR_NETWORK_IDLE=true` while debugging.

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

With strict notifications enabled, score-based alerts must also have at least `STRICT_MIN_POSITIVE_SIGNALS` positive signals and no more than `STRICT_MAX_NEGATIVE_SIGNALS` negative signals. The value override bypasses this strict filter: if `estimated_value_eur >= MIN_VALUE_TO_NOTIFY_EUR`, the product is notified anyway.

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
- `estimated_value_eur`
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
