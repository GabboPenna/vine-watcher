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
VINE_WATCHER_IMAGE=gabrielepennacchia/vine-watcher:0.2.0 docker compose up -d watcher
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

## Useful Commands

```bash
npm run docker:build
npm run docker:up
npm run docker:logs
npm run docker:login
npm run docker:login:finish
```

## Image Publishing

The Docker workflow builds images on pushes and pull requests. It publishes to Docker Hub only when a semver tag such as `v0.2.0` is pushed.

Required GitHub repository secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Optional repository variable:

- `DOCKERHUB_REPOSITORY`, for example `gabrielepennacchia/vine-watcher`

Release tags publish:

- `0.2.0`
- `0.2`
- `0`
- `latest`
- `sha-<commit>`
