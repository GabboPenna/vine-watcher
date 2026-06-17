"use strict";

const { createBrowserContext } = require("./browser");
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { scoreProduct } = require("./scorer");
const { SessionNeedsAttentionError, VineScanner } = require("./scanner");
const { ProductStorage } = require("./storage");
const { delayWithJitter, sleep } = require("./utils");
const { TelegramClient } = require("./telegram");

async function runCycle({ scanner, storage, telegram, config, logger }) {
  const startedAt = Date.now();
  const products = await scanner.scanAllSections();
  let newProducts = 0;
  let notified = 0;
  let maxScore = null;

  for (const product of products) {
    const scoring = scoreProduct(product, config.keywords);
    if (maxScore === null || scoring.score > maxScore) {
      maxScore = scoring.score;
    }

    const saved = storage.saveProduct(product, scoring);
    if (saved.isNew) {
      newProducts += 1;
      logger.info(`New product score=${scoring.score} section="${product.section}" title="${product.title}"`);
    }

    const shouldNotify = saved.product.notified !== 1 && scoring.score >= config.minScoreToNotify;
    if (!shouldNotify) {
      continue;
    }

    if (notified >= config.maxNotificationsPerCycle) {
      logger.warn(
        `Notification limit reached; not notifying score=${scoring.score} title="${product.title}"`
      );
      continue;
    }

    try {
      const sent = await telegram.sendProduct(saved.product, scoring);
      if (sent) {
        storage.markNotified(saved.product.id);
        notified += 1;
        logger.info(`Telegram notification sent for product id=${saved.product.id} score=${scoring.score}`);
      }
    } catch (error) {
      logger.error(`Telegram notification failed for product id=${saved.product.id}: ${error.message}`);
    }
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(
    `Cycle complete: scanned=${products.length} new=${newProducts} notified=${notified} max_score=${
      maxScore === null ? "n/d" : maxScore
    } elapsed=${elapsedSeconds}s`
  );
}

async function main() {
  const once = process.argv.includes("--once");
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const storage = new ProductStorage(config.databasePath, logger.child("storage"));
  const telegram = new TelegramClient(config, logger.child("telegram"));
  let context = null;
  let shuttingDown = false;
  let lastCriticalNotificationAt = 0;

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Shutdown requested by ${signal}`);
    if (context) {
      await context.close().catch((error) => logger.warn(`Browser close failed: ${error.message}`));
    }
    storage.close();
    process.exit(exitCode);
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      logger.error(error);
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      logger.error(error);
      process.exit(1);
    });
  });

  storage.init();
  context = await createBrowserContext(config, logger.child("browser"));
  const scanner = new VineScanner({
    context,
    config,
    logger: logger.child("scanner")
  });

  logger.info(`Configured sections: ${config.sections.map((section) => section.name).join(", ")}`);

  do {
    try {
      await runCycle({ scanner, storage, telegram, config, logger });
    } catch (error) {
      if (error instanceof SessionNeedsAttentionError) {
        logger.error(error.message);
        if (config.notifyCriticalErrors && Date.now() - lastCriticalNotificationAt > config.criticalNotificationCooldownMs) {
          lastCriticalNotificationAt = Date.now();
          await telegram.sendCriticalError(error).catch((telegramError) => {
            logger.warn(`Critical Telegram notification failed: ${telegramError.message}`);
          });
        }

        if (config.exitOnSessionAttention) {
          await shutdown("session attention", 2);
          return;
        }
      } else {
        logger.error(error);
        if (config.notifyCriticalErrors && Date.now() - lastCriticalNotificationAt > config.criticalNotificationCooldownMs) {
          lastCriticalNotificationAt = Date.now();
          await telegram.sendCriticalError(error).catch((telegramError) => {
            logger.warn(`Critical Telegram notification failed: ${telegramError.message}`);
          });
        }
      }
    }

    if (once || shuttingDown) {
      break;
    }

    const waitMs = delayWithJitter(config.scanIntervalSeconds, config.scanJitterSeconds);
    logger.info(`Next scan in ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  } while (!shuttingDown);

  if (context) {
    await context.close();
  }
  storage.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  runCycle
};
