# Docker Compose

Docker Compose is the portable way to run Vine Watcher with a persistent data volume.

The stack has two services:

- `watcher`: continuous Vine watcher
- `login`: temporary noVNC browser used only for manual Amazon login

## Configure

Application config:

```bash
cp .env.example .env
nano .env
```

Docker Compose wrapper settings are optional. Use them only when you want to override image name, noVNC binding, or env-file path:

```bash
cp compose.env.example .compose.env
docker compose --env-file .compose.env up -d watcher
```

Application settings stay in `.env`; `.compose.env` only controls Compose-level behavior.

## Build and Run From Source

```bash
docker compose build
docker compose up -d watcher
docker compose logs -f watcher
```

## Use the Published Image

```bash
docker pull gabrielepennacchia/vine-watcher:latest
docker compose up -d watcher
```

To pin a release:

```bash
VINE_WATCHER_IMAGE=gabrielepennacchia/vine-watcher:0.7.0 docker compose up -d watcher
```

## Manual Amazon Login

Stop the watcher:

```bash
docker compose stop watcher
```

Start the temporary noVNC login container:

```bash
docker compose --profile login up login
```

Open the printed noVNC URL and complete Amazon login manually.

When Vine is visible and stable, run this in a second terminal:

```bash
npm run docker:login:finish
```

Then start the watcher again:

```bash
docker compose up -d watcher
docker compose logs -f watcher
```

## Data

Docker uses a named volume:

```text
vine-watcher_vine-data
```

It stores:

- SQLite database
- persistent Chromium profile

## Health API

The Compose file maps the watcher's health API to the host loopback address:

```text
127.0.0.1:8765 -> watcher:8765
```

Compose enables the health server inside the container and attaches a native container healthcheck. Configure its port, freshness window, and optional token in `.env`:

```bash
HEALTH_SERVER_PORT=8765
HEALTH_SERVER_TOKEN=change-me
HEALTH_STALE_AFTER_SECONDS=300
```

Then test from the Docker host:

```bash
curl -H "Authorization: Bearer change-me" http://127.0.0.1:8765/health
```

To bind a different host IP or port, set `HEALTH_BIND` and `HEALTH_SERVER_PORT` before starting Compose. Keep the default `HEALTH_BIND=127.0.0.1` unless you intentionally want to expose diagnostics outside the host.

The default Compose limits are `2g` memory and 256 processes for both watcher and login helper. Override `VINE_WATCHER_MEMORY_LIMIT`, `VINE_WATCHER_LOGIN_MEMORY_LIMIT`, or `VINE_WATCHER_PIDS_LIMIT` in `.compose.env` for smaller or larger hosts.

## Useful Commands

```bash
npm run docker:build
npm run docker:up
npm run docker:logs
npm run docker:login
npm run docker:login:finish
```

## Image Publishing

The Docker workflow validates image changes on pull requests and publishes to Docker Hub only when a semver tag such as `v0.7.0` is pushed. Main-branch CI remains separate, avoiding a duplicate image build when a release commit and tag are pushed together.

Required GitHub repository secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Optional repository variable:

- `DOCKERHUB_REPOSITORY`, for example `gabrielepennacchia/vine-watcher`

Release tags publish:

- `0.7.0`
- `0.7`
- `0`
- `latest`
- `sha-<commit>`
