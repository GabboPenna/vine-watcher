# Configuration

Vine Watcher reads configuration from environment variables. For local/systemd installs, start with:

```bash
cp .env.example .env
```

For Docker Compose, the same `.env` file is passed to the watcher container.

## Telegram

```bash
TELEGRAM_BOT_TOKEN=123456:ABCDEF
TELEGRAM_CHAT_ID=123456789
TELEGRAM_CONTROL_ENABLED=false
TELEGRAM_CONTROL_POLL_SECONDS=3
TELEGRAM_CONTROL_LANGUAGE=en
```

Create a bot with BotFather, send it at least one message, then fetch updates:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Use the `chat.id` value.

Never commit real tokens.

## Telegram Control

Telegram Control is optional. It lets you change runtime settings from the same private chat used for notifications:

```bash
TELEGRAM_CONTROL_ENABLED=true
TELEGRAM_CONTROL_POLL_SECONDS=3
TELEGRAM_CONTROL_LANGUAGE=en
```

The control loop uses Telegram long polling. You do not need a webhook, public URL, open port, reverse proxy, or TLS certificate.

When the control loop starts, it registers Telegram's native command menu and sets the chat menu button to `commands`. Send `/menu` to open the inline button control panel.

Security behavior:

- only messages from `TELEGRAM_CHAT_ID` are accepted
- runtime overrides are stored in the local SQLite database
- secrets stay in `.env`
- commands never request or order Vine products

Commands:

```text
/menu
/help
/lang it|en
/status
/config
/notify_all on|off
/notify_all always
/notify_all_window 09:00-22:30
/notify_all_window off
/min_score 5
/min_value 35
/strict on|off
/strict_signals 2 0
/max_notifications 10
/panic on|off
/panic 30
/panic_interval 5 0
/scan_interval 30 10
/fast on|off
/reset key
/reset all
```

Runtime overrides are applied before every scan cycle. Use `/reset all` to return to the `.env` defaults.

## Vine Sections

```bash
AMAZON_VINE_BASE_URL=https://www.amazon.it/vine/vine-items
SCAN_ALL_ITEMS=false
```

Default sections:

- `Recommended for you`: `queue=potluck`
- `Additional items`: `queue=encore`
- `All items`: `queue=last_chance`, disabled unless `SCAN_ALL_ITEMS=true`

Add custom sections:

```bash
EXTRA_SECTIONS_JSON=[{"name":"Zigbee search","url":"https://www.amazon.it/vine/vine-items?queue=encore&search=zigbee","enabled":true}]
```

Override all sections:

```bash
SECTIONS_JSON=[{"name":"Only recommended","url":"https://www.amazon.it/vine/vine-items?queue=potluck","enabled":true}]
```

## Scanner

```bash
SCAN_INTERVAL_SECONDS=30
SCAN_JITTER_SECONDS=10
PAGE_TIMEOUT_SECONDS=45
WAIT_FOR_NETWORK_IDLE=false
PRODUCT_READY_TIMEOUT_SECONDS=5
PAGE_SETTLE_SECONDS=1
SECTION_DELAY_SECONDS=1
BROWSER_RESTART_INTERVAL_MINUTES=180
BLOCK_RESOURCE_TYPES=font,media
```

For aggressive short windows:

```bash
PANIC_MODE=false
PANIC_UNTIL=
PANIC_SCAN_INTERVAL_SECONDS=10
PANIC_SCAN_JITTER_SECONDS=3
```

Fast personal instance profile:

```bash
PANIC_MODE=true
PANIC_SCAN_INTERVAL_SECONDS=5
PANIC_SCAN_JITTER_SECONDS=0
SCAN_INTERVAL_SECONDS=10
SCAN_JITTER_SECONDS=0
PAGE_TIMEOUT_SECONDS=18
PRODUCT_READY_TIMEOUT_SECONDS=2
PAGE_SETTLE_SECONDS=0
SECTION_DELAY_SECONDS=0
WAIT_FOR_NETWORK_IDLE=false
BLOCK_RESOURCE_TYPES=image,font,media
```

This profile scans much more often and blocks product images for speed. It is useful for a private instance you actively watch, but the default profile is more conservative.

`BROWSER_RESTART_INTERVAL_MINUTES` closes and reopens the Chromium context periodically while keeping the persistent browser profile. This helps long-running small hosts release Chromium memory before it grows into an OOM condition. Set it to `0` to disable automatic browser recycling.

## Notifications

```bash
NOTIFY_ALL_PRODUCTS=false
NOTIFY_ALL_PRODUCTS_WINDOW=
MIN_SCORE_TO_NOTIFY=20
MIN_VALUE_TO_NOTIFY_EUR=50
STRICT_NOTIFY_MODE=true
STRICT_MIN_POSITIVE_SIGNALS=2
STRICT_MAX_NEGATIVE_SIGNALS=0
MAX_NOTIFICATIONS_PER_CYCLE=5
```

Set `NOTIFY_ALL_PRODUCTS=true` to notify every unnotified product the watcher sees, regardless of score, strict filters, or estimated value. This still respects `MAX_NOTIFICATIONS_PER_CYCLE` to avoid Telegram floods.

Set `NOTIFY_ALL_PRODUCTS_WINDOW=09:00-22:30` to enable notify-all only during a local daily time window. The configured `TZ` value is used, defaults to `Europe/Rome`, and the end time is exclusive. Overnight windows such as `22:00-06:00` are supported.

The value override bypasses strict score filtering. If a product has a visible estimated value greater than or equal to `MIN_VALUE_TO_NOTIFY_EUR`, it is notified.

## Session Health

```bash
NOTIFY_CRITICAL_ERRORS=true
CRITICAL_NOTIFICATION_COOLDOWN_SECONDS=900
SESSION_ATTENTION_MAX_FAILURES=2
SESSION_ATTENTION_COOLDOWN_SECONDS=300
VERIFY_SESSION_ATTENTION=true
SESSION_ATTENTION_GRACE_SECONDS=300
SESSION_FAILURE_BACKOFF_SECONDS=90
STOP_ON_SESSION_ATTENTION=true
```

Behavior:

- suspected login failures are confirmed with a second Vine health check
- recent successful scans create a grace window
- transient login redirects back off instead of immediately failing
- CAPTCHA and real manual verification still require user action

On personal instances where false login redirects are frequent, set:

```bash
STOP_ON_SESSION_ATTENTION=false
```

## Storage

```bash
DATABASE_PATH=./data/vine-watcher.sqlite
PLAYWRIGHT_USER_DATA_DIR=./data/chromium-profile
```

The Chromium profile is local runtime state. Do not commit it.

## Browser Mode

```bash
HEADLESS=false
CHROMIUM_NO_SANDBOX=false
```

The packaged systemd service overrides browser startup with Xvfb:

```bash
VINE_WATCHER_XVFB=true
```

Docker sets `CHROMIUM_NO_SANDBOX=true` because containers commonly require it.
