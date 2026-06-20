"use strict";

const { createBrowserContext } = require("./browser");
const { loadConfig } = require("./config");
const { TelegramControl } = require("./control");
const { createLogger } = require("./logger");
const { applyRuntimeSettings } = require("./runtime-config");
const { scoreProduct } = require("./scorer");
const {
  isBrowserClosedError,
  SessionNeedsAttentionError,
  summarizeSessionStatus,
  VineScanner
} = require("./scanner");
const { ProductStorage } = require("./storage");
const { isTimeWindowActive, parseTimeWindow } = require("./time-window");
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

function notifyAllProductsReason(config, nowMs = Date.now()) {
  if (config.notifyAllProducts) {
    return "notify all products mode";
  }

  if (config.notifyAllProductsWindow && isTimeWindowActive(config.notifyAllProductsWindow, config.timezoneId, nowMs)) {
    const window = parseTimeWindow(config.notifyAllProductsWindow);
    return `notify all products window ${window ? window.label : config.notifyAllProductsWindow}`;
  }

  return "";
}

function isNotifyAllProductsActive(config, nowMs = Date.now()) {
  return Boolean(notifyAllProductsReason(config, nowMs));
}

function notificationTriggers(product, scoring, config, nowMs = Date.now()) {
  const triggers = [];

  const notifyAllReason = notifyAllProductsReason(config, nowMs);
  if (notifyAllReason) {
    triggers.push(notifyAllReason);
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

  return {
    scanned,
    newProducts,
    notified,
    maxScore: maxScore === null ? "n/d" : maxScore,
    elapsedSeconds
  };
}

async function main() {
  const once = process.argv.includes("--once");
  const baseConfig = loadConfig();
  const logger = createLogger({ level: baseConfig.logLevel });
  const storage = new ProductStorage(baseConfig.databasePath, logger.child("storage"));
  const telegram = new TelegramClient(baseConfig, logger.child("telegram"));
  const runtimeStatus = {
    lastCycle: null
  };
  let effectiveConfig = baseConfig;
  let control = null;
  let context = null;
  let scanner = null;
  let browserStartedAt = 0;
  let shuttingDown = false;
  let lastCriticalNotificationAt = 0;
  let lastSessionAttentionNotificationAt = 0;
  let consecutiveSessionAttentionFailures = 0;
  let lastKnownGoodSessionAt = Date.now();
  let nextDelayOverrideMs = 0;
  let nextDelayReason = "";

  function refreshConfig() {
    effectiveConfig = applyRuntimeSettings(baseConfig, storage.getSettings());
    return effectiveConfig;
  }

  function shouldRestartBrowser(config, now = Date.now()) {
    return Boolean(
      config.browserRestartIntervalMs > 0 &&
        browserStartedAt > 0 &&
        now - browserStartedAt >= config.browserRestartIntervalMs
    );
  }

  async function openBrowserContext(reason) {
    if (context) {
      logger.info(`Closing Chromium context before reopening (${reason})`);
      await context.close().catch((error) => logger.warn(`Browser close failed: ${error.message}`));
      context = null;
    }

    refreshConfig();
    context = await createBrowserContext(effectiveConfig, logger.child("browser"));
    browserStartedAt = Date.now();
    scanner = new VineScanner({
      context,
      config: effectiveConfig,
      logger: logger.child("scanner")
    });
    logger.info(
      `Chromium context ready (${reason}); recycle_interval=${Math.round(
        effectiveConfig.browserRestartIntervalMs / 60000
      )}m`
    );
  }

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Shutdown requested by ${signal}`);
    if (control) {
      control.stop();
    }
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
  refreshConfig();
  await openBrowserContext("startup");

  control = new TelegramControl({
    telegram,
    storage,
    getConfig: () => effectiveConfig,
    getStatus: () => runtimeStatus,
    logger: logger.child("control")
  });
  if (!once) {
    await control.start();
  }

  logger.info(`Configured sections: ${effectiveConfig.sections.map((section) => section.name).join(", ")}`);
  if (effectiveConfig.panicMode || effectiveConfig.panicUntilMs) {
    const until = effectiveConfig.panicUntilMs ? new Date(effectiveConfig.panicUntilMs).toISOString() : "manual stop";
    logger.info(
      `Panic mode configured: active=${isPanicActive(effectiveConfig)} until=${until} ` +
        `interval=${effectiveConfig.panicScanIntervalSeconds}s jitter=${effectiveConfig.panicScanJitterSeconds}s`
    );
  }
  if (effectiveConfig.notifyAllProducts || effectiveConfig.notifyAllProductsWindow) {
    logger.info(
      `Notify all products configured: active=${isNotifyAllProductsActive(effectiveConfig)} ` +
        `always=${effectiveConfig.notifyAllProducts} window=${effectiveConfig.notifyAllProductsWindow || "none"} ` +
        `timezone=${effectiveConfig.timezoneId}`
    );
  }

  do {
    refreshConfig();
    scanner.config = effectiveConfig;
    try {
      runtimeStatus.lastCycle = await runCycle({ scanner, storage, telegram, config: effectiveConfig, logger });
      consecutiveSessionAttentionFailures = 0;
      lastKnownGoodSessionAt = Date.now();
    } catch (error) {
      if (error instanceof SessionNeedsAttentionError) {
        let sessionAttentionConfirmed = true;
        let confirmedHealthStatus = null;
        if (effectiveConfig.verifySessionAttention && error.confirmable) {
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
          const deferSessionAttention = shouldDeferSessionAttention(error, effectiveConfig, lastKnownGoodSessionAt, now);
          const willStop =
            effectiveConfig.stopOnSessionAttention &&
            consecutiveSessionAttentionFailures >= effectiveConfig.sessionAttentionMaxFailures &&
            !deferSessionAttention;

          const sessionSummary = summarizeSessionStatus(confirmedHealthStatus || error.details);
          const baseSessionLog =
            `${error.message} consecutive_session_attention=${consecutiveSessionAttentionFailures}/` +
            `${effectiveConfig.sessionAttentionMaxFailures} recent_good_session=${
              recentGoodSeconds === null ? "none" : `${recentGoodSeconds}s`
            } ${sessionSummary}`;

          if (deferSessionAttention) {
            nextDelayOverrideMs = Math.max(nextDelayOverrideMs, effectiveConfig.sessionFailureBackoffMs);
            nextDelayReason = "session backoff";
            logger.warn(
              `${baseSessionLog}; treating as transient because a good scan happened within ` +
                `${Math.round(effectiveConfig.sessionAttentionGraceMs / 1000)}s, backing off instead of stopping`
            );
          } else {
            if (!willStop) {
              nextDelayOverrideMs = Math.max(nextDelayOverrideMs, effectiveConfig.sessionFailureBackoffMs);
              nextDelayReason = "session backoff";
              logger.error(`${baseSessionLog}; backing off before retry`);
            } else {
              logger.error(baseSessionLog);
            }
          }

          if (
            !deferSessionAttention &&
            effectiveConfig.notifyCriticalErrors &&
            (willStop || Date.now() - lastSessionAttentionNotificationAt > effectiveConfig.sessionAttentionCooldownMs)
          ) {
            lastSessionAttentionNotificationAt = Date.now();
            await telegram
              .sendSessionAttention(error, {
                failureCount: consecutiveSessionAttentionFailures,
                maxFailures: effectiveConfig.sessionAttentionMaxFailures,
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
        if (
          effectiveConfig.notifyCriticalErrors &&
          Date.now() - lastCriticalNotificationAt > effectiveConfig.criticalNotificationCooldownMs
        ) {
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

    refreshConfig();
    if (shouldRestartBrowser(effectiveConfig)) {
      const ageMinutes = Math.round((Date.now() - browserStartedAt) / 60000);
      await openBrowserContext(`scheduled recycle after ${ageMinutes}m`);
    } else {
      scanner.config = effectiveConfig;
    }
    const waitMs = nextDelayOverrideMs > 0 ? nextDelayOverrideMs : nextScanDelayMs(effectiveConfig);
    const waitReason =
      nextDelayOverrideMs > 0 ? ` (${nextDelayReason})` : isPanicActive(effectiveConfig) ? " (panic mode)" : "";
    nextDelayOverrideMs = 0;
    nextDelayReason = "";
    logger.info(`Next scan in ${Math.round(waitMs / 1000)}s${waitReason}`);
    await sleep(waitMs);
  } while (!shuttingDown);

  if (context) {
    await context.close();
  }
  if (control) {
    control.stop();
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
  isNotifyAllProductsActive,
  isTimeWindowActive,
  notificationTriggers,
  runCycle,
  shouldDeferSessionAttention
};
