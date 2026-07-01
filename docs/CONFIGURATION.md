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
/dashboard
/latest 10
/latest unnotified 10
/why search text
/replay search text 3
/profile conservative
/profile balanced
/profile drop
/profile notify-all
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
/adaptive on|off
/adaptive 4 45 4 12 2
/fast on|off
/reset key
/reset all
```

Runtime overrides are applied before every scan cycle. Use `/reset all` to return to the `.env` defaults.

`/adaptive 4 45 4 12 2` means:

- idle after 4 unchanged cycles
- idle interval 45 seconds
- active for 4 cycles after movement
- active interval 12 seconds
- active jitter 2 seconds

Profiles are runtime presets:

- `conservative`: slower scans, strict filters, no notify-all.
- `balanced`: practical daily defaults with score/value alerts and memory recycling.
- `drop`: aggressive scan timing for active drop windows.
- `notify-all`: notify every newly seen product 24/7 and clear the notify-all window.

Diagnostics are based on the local SQLite database. `/why` explains saved products; `/replay` resends saved products intentionally; `/dashboard` shows recent scan-cycle summaries.

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
ADAPTIVE_SCAN_ENABLED=false
ADAPTIVE_IDLE_AFTER_CYCLES=5
ADAPTIVE_IDLE_INTERVAL_SECONDS=60
ADAPTIVE_ACTIVE_CYCLES=3
ADAPTIVE_ACTIVE_INTERVAL_SECONDS=15
ADAPTIVE_ACTIVE_JITTER_SECONDS=3
PAGE_TIMEOUT_SECONDS=45
SECTION_HARD_TIMEOUT_SECONDS=0
WAIT_FOR_NETWORK_IDLE=false
PRODUCT_READY_TIMEOUT_SECONDS=5
PAGE_SETTLE_SECONDS=1
SECTION_DELAY_SECONDS=1
SECTION_SCAN_CONCURRENCY=1
REUSE_SECTION_PAGES=false
DETAIL_VALUE_LOOKUP_ENABLED=true
DETAIL_VALUE_LOOKUP_MAX_PER_CYCLE=10
DETAIL_VALUE_LOOKUP_TIMEOUT_SECONDS=4
SCANNER_TURBO_ONLY_DURING_ADAPTIVE_ACTIVE=false
BROWSER_RESTART_INTERVAL_MINUTES=180
BROWSER_MEMORY_RECYCLE_MB=0
BROWSER_MEMORY_RECYCLE_COOLDOWN_MINUTES=10
BLOCK_RESOURCE_TYPES=font,media
LAYOUT_HEALTH_MIN_PRODUCTS=0
LAYOUT_HEALTH_WARN_AFTER_CYCLES=3
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

For a faster personal instance, you can scan Vine sections in parallel and keep one Chromium tab per section:

```bash
SECTION_SCAN_CONCURRENCY=2
REUSE_SECTION_PAGES=true
SECTION_DELAY_SECONDS=0
PAGE_SETTLE_SECONDS=0
PRODUCT_READY_TIMEOUT_SECONDS=2
```

`SECTION_SCAN_CONCURRENCY=2` starts `Recommended for you` and `Additional items` together. The watcher processes whichever section finishes first, so a fast `Additional items` result can notify without waiting for `Recommended for you`.

`REUSE_SECTION_PAGES=true` keeps a dedicated Chromium page open for each section and navigates it again on the next cycle instead of creating and closing a new page every time. If a reused page errors, Vine Watcher discards it and creates a fresh one on the next scan.

`DETAIL_VALUE_LOOKUP_ENABLED=true` lets Vine Watcher perform a short read-only Vine detail lookup when a product card does not expose the estimated value. This reads the Vine detail `taxValue` field, stores it as `estimated_value_eur`, and lets `MIN_VALUE_TO_NOTIFY_EUR` work from the same value Amazon shows as `Valore fiscale stimato`. Lookups are limited by `DETAIL_VALUE_LOOKUP_MAX_PER_CYCLE` and `DETAIL_VALUE_LOOKUP_TIMEOUT_SECONDS` so a busy drop does not turn into an unbounded detail crawl.

If a product already matches score, strict, or notify-all rules, Vine Watcher sends the Telegram notification immediately. When the value lookup finishes afterward, it edits the same Telegram message or caption with the recovered value. If the product would only be notified because it crosses `MIN_VALUE_TO_NOTIFY_EUR`, the lookup must happen before notification because the value is the trigger.

To keep resource use lower while Vine is quiet, enable turbo scanning only during adaptive active windows:

```bash
SCANNER_TURBO_ONLY_DURING_ADAPTIVE_ACTIVE=true
SECTION_SCAN_CONCURRENCY=2
REUSE_SECTION_PAGES=true
```

With this setup idle cycles scan serially and close reusable section tabs. When adaptive active starts, Vine Watcher switches to parallel section scanning and reusable tabs for the fast drop window.

`SECTION_HARD_TIMEOUT_SECONDS` is a safety watchdog around the whole section scan. Leave it at `0` for auto mode, which uses `PAGE_TIMEOUT_SECONDS` plus a margin. Set it explicitly on small hosts if Chromium ever gets stuck after an Amazon navigation timeout; the watcher will close the stuck page instead of letting a renderer grow until the service is killed.

Adaptive scanning can speed up briefly when the watcher sees movement and slow down after repeated idle cycles:

```bash
ADAPTIVE_SCAN_ENABLED=true
ADAPTIVE_IDLE_AFTER_CYCLES=5
ADAPTIVE_IDLE_INTERVAL_SECONDS=60
ADAPTIVE_ACTIVE_CYCLES=3
ADAPTIVE_ACTIVE_INTERVAL_SECONDS=15
ADAPTIVE_ACTIVE_JITTER_SECONDS=3
```

Panic mode still wins over adaptive scanning. Use adaptive scanning for daily unattended operation; use panic mode for short active drop windows.

`BROWSER_RESTART_INTERVAL_MINUTES` closes and reopens the Chromium context periodically while keeping the persistent browser profile. This helps long-running small hosts release Chromium memory before it grows into an OOM condition. Set it to `0` to disable automatic browser recycling.

`BROWSER_MEMORY_RECYCLE_MB` is an optional Linux process-tree RSS guard. When set above `0`, Vine Watcher sums the Node/Chromium process tree memory and recycles Chromium if it crosses the configured MB threshold. `BROWSER_MEMORY_RECYCLE_COOLDOWN_MINUTES` prevents repeated recycle loops.

Layout health warnings are diagnostic only. If a complete cycle keeps finding very few products, the cycle summary stores a warning so you can tell whether Amazon layout/session behavior may need review.

```bash
LAYOUT_HEALTH_MIN_PRODUCTS=0
LAYOUT_HEALTH_WARN_AFTER_CYCLES=3
```

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

The value override bypasses strict score filtering. If a product has an estimated Vine value greater than or equal to `MIN_VALUE_TO_NOTIFY_EUR`, it is notified. The value can come from the card when visible, or from the read-only Vine detail `taxValue` lookup when `DETAIL_VALUE_LOOKUP_ENABLED=true`.

## Scoring Rules

Built-in keywords live in `src/config.js`, but you can add or replace scoring lists without editing JavaScript:

```bash
SCORING_RULES_PATH=./data/scoring-rules.yml
SCORING_RULES_JSON=
```

JSON example:

```json
{
  "append": {
    "positiveKeywordsHigh": ["custom-widget"],
    "smartHomeKeywords": ["thread border router"]
  },
  "replace": {
    "negativeKeywords": ["costume", "party"]
  }
}
```

Simple YAML example:

```yaml
append:
  positiveKeywordsHigh:
    - custom-widget
  smartHomeKeywords:
    - thread border router
```

Top-level arrays are also treated as append rules:

```yaml
positiveKeywordsHigh:
  - garage sensor
```

The supported keys are the same keyword arrays used by the scorer, such as `positiveKeywordsHigh`, `brandKeywords`, `smartHomeKeywords`, `homeApplianceKeywords`, `negativeKeywords`, and `nicheReplacementKeywords`.

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
RETENTION_PRODUCTS_DAYS=0
RETENTION_SCAN_CYCLES_DAYS=30
SQLITE_VACUUM_INTERVAL_HOURS=24
```

The Chromium profile is local runtime state. Do not commit it.

The database stores product history plus current inventory state:

- `present_now=1`: seen in the latest complete inventory cycle
- `present_now=0`: previously seen but not present anymore
- `reappeared_count`: how many times a gone product came back
- `last_triggers_json`, `last_blockers_json`, `last_config_json`, `last_decision`: diagnostic snapshot from the latest scan

Retention only deletes old gone products when `RETENTION_PRODUCTS_DAYS` is greater than `0`. Scan-cycle history is kept for `RETENTION_SCAN_CYCLES_DAYS`, default 30 days. SQLite vacuum runs on the configured maintenance interval.

## Health API

The health API is local and read-only. It is disabled by default.

```bash
HEALTH_SERVER_ENABLED=false
HEALTH_SERVER_HOST=127.0.0.1
HEALTH_SERVER_PORT=8765
HEALTH_SERVER_TOKEN=
```

When `HEALTH_SERVER_TOKEN` is set, use either:

```bash
curl -H "Authorization: Bearer change-me" http://127.0.0.1:8765/health
```

or:

```bash
curl "http://127.0.0.1:8765/health?token=change-me"
```

Endpoints:

```text
/health                         JSON health, last cycle, memory, and totals
/metrics                        Prometheus-style text metrics
/last-cycle                     latest cycle plus recent scan-cycle history
/latest-products?mode=present   recent products; modes include all, present, gone, notified, unnotified, top
```

Home Assistant can read `/health` with a REST sensor or `/metrics` through a Prometheus integration.

## Dry Run

```bash
npm run dry-run:once
```

Dry-run performs one real scan and records product diagnostics, but does not send Telegram product notifications and does not mark products as notified. It is useful after changing rules, thresholds, sections, or scheduler settings.

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
