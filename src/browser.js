"use strict";

const { chromium } = require("playwright");
const { ensureDir } = require("./utils");

async function createBrowserContext(config, logger, options = {}) {
  ensureDir(config.playwrightUserDataDir);

  const headless = options.headless ?? config.headless;
  logger.info(`Opening Chromium persistent context in ${headless ? "headless" : "headed"} mode`);

  const context = await chromium.launchPersistentContext(config.playwrightUserDataDir, {
    headless,
    acceptDownloads: false,
    locale: "it-IT",
    timezoneId: config.timezoneId,
    viewport: {
      width: 1365,
      height: 900
    },
    args: ["--disable-dev-shm-usage"]
  });

  context.setDefaultTimeout(config.pageTimeoutMs);
  context.setDefaultNavigationTimeout(config.pageTimeoutMs);

  return context;
}

module.exports = {
  createBrowserContext
};
