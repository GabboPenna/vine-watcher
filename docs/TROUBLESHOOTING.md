# Troubleshooting

## Service Status

```bash
systemctl status vine-watcher.service
journalctl -u vine-watcher.service -f
```

Expected healthy logs:

```text
Section "Recommended for you" scanned: N product candidates
Section "Additional items" scanned: N product candidates
Cycle complete: scanned=N new=N notified=N max_score=N
```

## Telegram Works, But No Notifications Arrive

Check what the watcher is seeing:

```bash
cd /opt/vine-watcher-telegram
sudo -u vinewatcher -H npm run stats
```

If `max_score` is below `MIN_SCORE_TO_NOTIFY` and `max_estimated_value_eur` is empty or below `MIN_VALUE_TO_NOTIFY_EUR`, silence is expected.

## Amazon Login Required

Run manual login:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh start
```

Complete login in noVNC, then:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh finish
sudo systemctl restart vine-watcher.service
```

If logs show repeated false `/ap/signin` redirects while you are still logged in, prefer the Xvfb/headed service mode:

```text
Environment=HEADLESS=false
Environment=VINE_WATCHER_XVFB=true
```

## Service Is Slow

Look for long navigation timeouts:

```bash
journalctl -u vine-watcher.service --since "10 minutes ago" --no-pager
```

Occasional `page.goto: Timeout ...` or `net::ERR_FAILED` errors on a single Vine queue are usually transient Amazon/network hiccups. Vine Watcher keeps scanning the other configured sections and records the cycle as partial. If every section fails, or Amazon asks for login/CAPTCHA, it is still treated as a real attention condition.

For a temporary aggressive window:

```bash
PANIC_SCAN_INTERVAL_SECONDS=5
PANIC_SCAN_JITTER_SECONDS=1
PAGE_TIMEOUT_SECONDS=25
PRODUCT_READY_TIMEOUT_SECONDS=3
PAGE_SETTLE_SECONDS=0.3
SECTION_DELAY_SECONDS=0
```

Use these carefully. Very aggressive scans may increase Amazon friction.

If Chromium gets stuck and memory/load grows, disable parallel scanning first and use a hard section watchdog:

```bash
SECTION_SCAN_CONCURRENCY=1
REUSE_SECTION_PAGES=false
SECTION_HARD_TIMEOUT_SECONDS=30
BROWSER_MEMORY_RECYCLE_MB=900
```

## Too Many Notifications

Raise thresholds:

```bash
MIN_SCORE_TO_NOTIFY=25
MAX_NOTIFICATIONS_PER_CYCLE=3
```

Then restart:

```bash
sudo systemctl restart vine-watcher.service
```

## Need Seen Product Data

```bash
cd /opt/vine-watcher-telegram
sudo -u vinewatcher -H npm run stats
sudo -u vinewatcher -H npm run export:csv
```

## Docker Logs

```bash
docker compose logs -f watcher
```

Manual login:

```bash
docker compose stop watcher
docker compose --profile login up login
npm run docker:login:finish
docker compose up -d watcher
```
