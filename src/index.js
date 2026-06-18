"use strict";

const { createBrowserContext } = require("./browser");
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { scoreProduct } = require("./scorer");
const {
  isBrowserClosedError,
  SessionNeedsAttentionError,
  summarizeSessionStatus,
  VineScanner
} = require("./scanner");
const { ProductStorage } = require("./storage");
const { delayWithJitter, sleep } = require("./utils");
const { TelegramClient } = require("./telegram");

function isPanicActive(config) {
  return Boolean(config.panicMode || (config.panicUntilMs && Date.now() < config.panicUntilMs));
}

function nextScanDelayMs(config) {
  if (isPanicActive(config)) {
    return delayWithJitter(config.panicScanIntervalSeconds, config.panicScanJitterSeconds);
  }
  return delayWithJitter(config.scanIntervalSeconds, config.scanJitterSeconds);
}

function secondsSince(timestampMs, now = Date.now()) {
  if (!timestampMs) {
    return null;
  }
  return Math.max(0, Math.round((now - timestampMs) / 1000));
}

function shouldDeferSessionAttention(error, config, lastKnownGoodSessionAt, now = Date.now()) {
  if (!error || error.kind === "captcha" || error.confirmable === false) {
    return false;
  }
  if (!config.sessionAttentionGraceMs || config.sessionAttentionGraceMs <= 0 || !lastKnownGoodSessionAt) {
    return false;
  }
  return now - lastKnownGoodSessionAt < config.sessionAttentionGraceMs;
}

function formatEuro(value) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "n/a";
  }
  return `\u20ac${parsed.toFixed(2)}`;
}

function notificationTriggers(product, scoring, config) {
  const triggers = [];

  if (config.notifyAllProducts) {
    triggers.push("notify all products mode");
    return triggers;
  }

  const estimatedValue =
    product.estimated_value_eur === null ||
    product.estimated_value_eur === undefined ||
    product.estimated_value_eur === ""
      ? Number.NaN
      : Number(product.estimated_value_eur);
  const valueTrigger =
    config.minValueToNotifyEur > 0 &&
    Number.isFinite(estimatedValue) &&
    estimatedValue >= config.minValueToNotifyEur;

  if (valueTrigger) {
    triggers.push(`estimated value ${formatEuro(estimatedValue)} >= ${formatEuro(config.minValueToNotifyEur)}`);
  }

  if (scoring.score >= config.minScoreToNotify) {
    if (!config.strictNotifyMode) {
      triggers.push(`score ${scoring.score} >= ${config.minScoreToNotify}`);
    } else if (
      scoring.positiveSignals >= config.strictMinPositiveSignals &&
      scoring.negativeSignals <= config.strictMaxNegativeSignals
    ) {
      triggers.push(
        `strict score ${scoring.score} >= ${config.minScoreToNotify} ` +
          `(${scoring.positiveSignals} positive, ${scoring.negativeSignals} negative)`
      );
    }
  }

  return triggers;
}

async function runCycle({ scanner, storage, telegram, config, logger }) {
  const startedAt = Date.now();
  let scanned = 0;
  let newProducts = 0;
  let notified = 0;
  let maxScore = null;

  for (const section of config.sections) {
    const products = await scanner.scanSection(section);
    scanned += products.length;

    for (const product of products) {
      const scoring = scoreProduct(product, config.keywords);
      if (maxScore === null || scoring.score > maxScore) {
        maxScore = scoring.score;
      }

      const saved = storage.saveProduct(product, scoring);
      if (saved.isNew) {
        newProducts += 1;
        logger.info(
          `New product score=${scoring.score} value=${formatEuro(product.estimated_value_eur)} ` +
            `section="${product.section}" title="${product.title}"`
        );
      }

      const triggers = notificationTriggers(saved.product, scoring, config);
      const shouldNotify = saved.product.notified !== 1 && triggers.length > 0;
      if (!shouldNotify) {
        continue;
      }

      if (notified >= config.maxNotificationsPerCycle) {
        logger.warn(
          `Notification limit reached; not notifying score=${scoring.score} ` +
            `value=${formatEuro(saved.product.estimated_value_eur)} title="${product.title}"`
        );
        continue;
      }

      try {
        const sent = await telegram.sendProduct(saved.product, {
          ...scoring,
          notificationTriggers: triggers
        });
        if (sent) {
          storage.markNotified(saved.product.id);
          notified += 1;
          logger.info(
            `Telegram notification sent for product id=${saved.product.id} score=${scoring.score} ` +
              `value=${formatEuro(saved.product.estimated_value_eur)} triggers="${triggers.join("; ")}"`
          );
        }
      } catch (error) {
        logger.error(`Telegram notification failed for product id=${saved.product.id}: ${error.message}`);
      }
    }

    if (config.sectionDelayMs > 0) {
      await sleep(config.sectionDelayMs);
    }
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(
    `Cycle complete: scanned=${scanned} new=${newProducts} notified=${notified} max_score=${
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
  let lastSessionAttentionNotificationAt = 0;
  let consecutiveSessionAttentionFailures = 0;
  let lastKnownGoodSessionAt = Date.now();
  let nextDelayOverrideMs = 0;
  let nextDelayReason = "";

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
  if (config.panicMode || config.panicUntilMs) {
    const until = config.panicUntilMs ? new Date(config.panicUntilMs).toISOString() : "manual stop";
    logger.info(
      `Panic mode configured: active=${isPanicActive(config)} until=${until} ` +
        `interval=${config.panicScanIntervalSeconds}s jitter=${config.panicScanJitterSeconds}s`
    );
  }

  do {
    try {
      await runCycle({ scanner, storage, telegram, config, logger });
      consecutiveSessionAttentionFailures = 0;
      lastKnownGoodSessionAt = Date.now();
    } catch (error) {
      if (error instanceof SessionNeedsAttentionError) {
        let sessionAttentionConfirmed = true;
        let confirmedHealthStatus = null;
        if (config.verifySessionAttention && error.confirmable) {
          try {
            const health = await scanner.verifySessionHealth();
            confirmedHealthStatus = health.status;
            if (health.ok) {
              sessionAttentionConfirmed = false;
              consecutiveSessionAttentionFailures = 0;
              lastKnownGoodSessionAt = Date.now();
              logger.warn(
                `Session attention was not confirmed by the health check; continuing. ` +
                  `original_kind=${error.kind} health_kind=${health.classification.kind} ` +
                  `health=${summarizeSessionStatus(health.status)}`
              );
            } else {
              logger.warn(
                `Session health check confirmed manual attention is needed: ` +
                  `kind=${health.classification.kind} health=${summarizeSessionStatus(health.status)}`
              );
            }
          } catch (healthError) {
            logger.warn(`Session health check failed; keeping original session failure: ${healthError.message}`);
          }
        }

        if (!sessionAttentionConfirmed) {
          logger.info("Session attention counter reset after successful health check");
        } else {
          consecutiveSessionAttentionFailures += 1;
          const now = Date.now();
          const recentGoodSeconds = secondsSince(lastKnownGoodSessionAt, now);
          const deferSessionAttention = shouldDeferSessionAttention(error, config, lastKnownGoodSessionAt, now);
          const willStop =
            config.stopOnSessionAttention &&
            consecutiveSessionAttentionFailures >= config.sessionAttentionMaxFailures &&
            !deferSessionAttention;

          const sessionSummary = summarizeSessionStatus(confirmedHealthStatus || error.details);
          const baseSessionLog =
            `${error.message} consecutive_session_attention=${consecutiveSessionAttentionFailures}/` +
            `${config.sessionAttentionMaxFailures} recent_good_session=${
              recentGoodSeconds === null ? "none" : `${recentGoodSeconds}s`
            } ${sessionSummary}`;

          if (deferSessionAttention) {
            nextDelayOverrideMs = Math.max(nextDelayOverrideMs, config.sessionFailureBackoffMs);
            nextDelayReason = "session backoff";
            logger.warn(
              `${baseSessionLog}; treating as transient because a good scan happened within ` +
                `${Math.round(config.sessionAttentionGraceMs / 1000)}s, backing off instead of stopping`
            );
          } else {
            if (!willStop) {
              nextDelayOverrideMs = Math.max(nextDelayOverrideMs, config.sessionFailureBackoffMs);
              nextDelayReason = "session backoff";
              logger.error(`${baseSessionLog}; backing off before retry`);
            } else {
              logger.error(baseSessionLog);
            }
          }

          if (
            !deferSessionAttention &&
            config.notifyCriticalErrors &&
            (willStop || Date.now() - lastSessionAttentionNotificationAt > config.sessionAttentionCooldownMs)
          ) {
            lastSessionAttentionNotificationAt = Date.now();
            await telegram
              .sendSessionAttention(error, {
                failureCount: consecutiveSessionAttentionFailures,
                maxFailures: config.sessionAttentionMaxFailures,
                willStop
              })
              .catch((telegramError) => {
                logger.warn(`Session attention Telegram notification failed: ${telegramError.message}`);
              });
          }

          if (willStop) {
            logger.error("Stopping watcher because Amazon session needs manual attention");
            await shutdown("session attention", once ? 2 : 0);
            return;
          }
        }
      } else if (shuttingDown && isBrowserClosedError(error)) {
        logger.info("Scan interrupted by shutdown");
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

    const waitMs = nextDelayOverrideMs > 0 ? nextDelayOverrideMs : nextScanDelayMs(config);
    const waitReason =
      nextDelayOverrideMs > 0 ? ` (${nextDelayReason})` : isPanicActive(config) ? " (panic mode)" : "";
    nextDelayOverrideMs = 0;
    nextDelayReason = "";
    logger.info(`Next scan in ${Math.round(waitMs / 1000)}s${waitReason}`);
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
  notificationTriggers,
  runCycle,
  shouldDeferSessionAttention
};
