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
  await configureRequestBlocking(context, config, logger);

  return context;
}

async function configureRequestBlocking(context, config, logger) {
  const blockedTypes = new Set(config.blockedResourceTypes || []);
  if (blockedTypes.size === 0) {
    return;
  }

  await context.route("**/*", async (route) => {
    const request = route.request();
    if (blockedTypes.has(request.resourceType())) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });

  logger.info(`Blocking browser resource types: ${Array.from(blockedTypes).join(", ")}`);
}

module.exports = {
  createBrowserContext
};
