# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim

LABEL org.opencontainers.image.title="Vine Watcher"
LABEL org.opencontainers.image.description="Local Amazon Vine watcher with Telegram notifications"
LABEL org.opencontainers.image.source="https://github.com/GabboPenna/vine-watcher"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATABASE_PATH=/data/vine-watcher.sqlite \
    PLAYWRIGHT_USER_DATA_DIR=/data/chromium-profile \
    HEADLESS=false \
    CHROMIUM_NO_SANDBOX=true \
    VINE_WATCHER_XVFB=true

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
    g++ \
    make \
    novnc \
    openbox \
    openssl \
    python3 \
    websockify \
    xauth \
    x11vnc \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --loglevel=error \
  && npx playwright install --with-deps chromium \
  && rm -rf /root/.npm \
  && mkdir -p /data /ms-playwright \
  && chown -R node:node /app /data /ms-playwright

COPY --chown=node:node . .

USER node

VOLUME ["/data"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["bash", "scripts/run-service.sh"]
