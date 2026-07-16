# Debian Installation

This guide installs Vine Watcher as a systemd service on Debian.

## One-Command Installer

```bash
git clone https://github.com/GabboPenna/vine-watcher.git
cd vine-watcher
sudo bash scripts/install-debian.sh
```

Optional custom locations and service accounts are applied consistently to systemd and the noVNC login helper:

```bash
sudo INSTALL_DIR=/srv/vine-watcher SERVICE_USER=vinewatcher bash scripts/install-debian.sh
```

The installer handles:

- required Debian packages
- Node.js check/install
- service user creation
- npm dependencies
- Playwright Chromium
- `.env` creation
- Telegram test
- systemd unit installation
- portable validation before handoff
- a hardened service unit with writable access limited to runtime data and the service home

The installer never asks for your Amazon password. Amazon login is always manual.

## Manual Install

```bash
sudo apt update
sudo apt install -y ca-certificates curl git sqlite3 nodejs npm build-essential python3 xvfb xauth

sudo useradd --system --user-group --create-home --home-dir /var/lib/vinewatcher --shell /usr/sbin/nologin vinewatcher
sudo mkdir -p /opt/vine-watcher-telegram
sudo chown -R vinewatcher:vinewatcher /opt/vine-watcher-telegram /var/lib/vinewatcher

sudo cp -a . /opt/vine-watcher-telegram/
cd /opt/vine-watcher-telegram

sudo -u vinewatcher npm ci --loglevel=error
sudo npx playwright install-deps chromium
sudo -u vinewatcher -H npx playwright install chromium

sudo cp .env.example .env
sudo nano .env
sudo chown vinewatcher:vinewatcher .env
sudo chmod 600 .env
```

## Amazon Login

Create the persistent Chromium profile before starting the service.

### Desktop or SSH X Forwarding

```bash
cd /opt/vine-watcher-telegram
sudo -u vinewatcher -H npm run login
```

Complete login, 2FA, or verification in Chromium. When Vine is visible and stable, press Enter in the terminal.

### Headless Server With noVNC

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh start
```

The helper stops `vine-watcher.service` first so two Chromium processes cannot open the same persistent profile.

Open the printed noVNC URL, enter the printed temporary password, and complete Amazon login manually.

When Vine is visible and stable:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh finish
```

Stop the temporary session without saving:

```bash
sudo /opt/vine-watcher-telegram/scripts/server-login.sh stop
```

## First Scan

```bash
cd /opt/vine-watcher-telegram
sudo -u vinewatcher -H npm run once
```

Expected success:

```text
Section "Recommended for you" scanned: N product candidates
Section "Additional items" scanned: N product candidates
Cycle complete: scanned=N new=N notified=N max_score=N
```

## systemd

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

## Virtual Display Runtime

The systemd service uses:

```text
scripts/run-service.sh -> xvfb-run -> npm run start
```

Chromium runs in headed mode inside a virtual display. This keeps the service non-interactive while avoiding the false Amazon login redirects often triggered by pure headless Chromium.
