"use strict";

const fs = require("fs");
const { createBrowserContext } = require("./browser");
const { loadConfig } = require("./config");
const { TelegramControl } = require("./control");
const { createLogger } = require("./logger");
const {
  formatEuro,
  isNotifyAllProductsActive,
  notificationTriggers
} = require("./notification-rules");
const { applyRuntimeSettings } = require("./runtime-config");
const { scoreProduct } = require("./scorer");
const {
  isBrowserClosedError,
  SessionNeedsAttentionError,
  summarizeSessionStatus,
  VineScanner
} = require("./scanner");
const { ProductStorage } = require("./storage");
const { isTimeWindowActive } = require("./time-window");
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

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_error) {
    return "";
  }
}

function processChildren(pid) {
  const text = readTextFile(`/proc/${pid}/task/${pid}/children`).trim();
  if (!text) {
    return [];
  }
  return text
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function processRssKb(pid) {
  const status = readTextFile(`/proc/${pid}/status`);
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB/im);
  return match ? Number(match[1]) : 0;
}

function processTreeRssMb(pid = process.pid, visited = new Set()) {
  if (visited.has(pid)) {
    return 0;
  }
  visited.add(pid);

  let totalKb = processRssKb(pid);
  for (const childPid of processChildren(pid)) {
    totalKb += processTreeRssMb(childPid, visited) * 1024;
  }

  if (pid === process.pid && totalKb === 0) {
    return process.memoryUsage().rss / 1024 / 1024;
  }
  return totalKb / 1024;
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

async function runCycle({ scanner, storage, telegram, config, logger }) {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let scanned = 0;
  let newProducts = 0;
  let notified = 0;
  let maxScore = null;
  let skippedAlreadyNotified = 0;
  let skippedNoTrigger = 0;
  let skippedNotificationLimit = 0;
  let telegramFailures = 0;
  const sections = [];

  for (const section of config.sections) {
    const products = await scanner.scanSection(section);
    scanned += products.length;
    sections.push({
      name: section.name,
      scanned: products.length
    });

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
        if (saved.product.notified === 1) {
          skippedAlreadyNotified += 1;
        } else {
          skippedNoTrigger += 1;
        }
        continue;
      }

      if (notified >= config.maxNotificationsPerCycle) {
        skippedNotificationLimit += 1;
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
        telegramFailures += 1;
        logger.error(`Telegram notification failed for product id=${saved.product.id}: ${error.message}`);
      }
    }

    if (config.sectionDelayMs > 0) {
      await sleep(config.sectionDelayMs);
    }
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  let outcome = "no_notifications";
  let reasonNoNotifications = "";
  if (notified > 0) {
    outcome = "sent_notifications";
    reasonNoNotifications = "sent notifications";
  } else if (scanned === 0) {
    outcome = "no_products";
    reasonNoNotifications = "no products found";
  } else if (skippedNotificationLimit > 0) {
    outcome = "notification_limit";
    reasonNoNotifications = "notification limit reached";
  } else if (telegramFailures > 0) {
    outcome = "telegram_failures";
    reasonNoNotifications = "telegram failures";
  } else if (newProducts === 0) {
    outcome = "all_seen";
    reasonNoNotifications = "all scanned products were already known";
  } else if (skippedNoTrigger > 0) {
    outcome = "no_matching_triggers";
    reasonNoNotifications = "new products did not match notification triggers";
  }

  logger.info(
    `Cycle complete: scanned=${scanned} new=${newProducts} notified=${notified} max_score=${
      maxScore === null ? "n/d" : maxScore
    } elapsed=${elapsedSeconds}s outcome=${outcome}`
  );

  return {
    startedAt: startedAtIso,
    completedAt: new Date().toISOString(),
    scanned,
    newProducts,
    notified,
    maxScore: maxScore === null ? "n/d" : maxScore,
    elapsedSeconds,
    skippedAlreadyNotified,
    skippedNoTrigger,
    skippedNotificationLimit,
    telegramFailures,
    outcome,
    reasonNoNotifications,
    sections
  };
}

async function main() {
  const once = process.argv.includes("--once");
  const baseConfig = loadConfig();
  const logger = createLogger({ level: baseConfig.logLevel });
  const storage = new ProductStorage(baseConfig.databasePath, logger.child("storage"));
  const telegram = new TelegramClient(baseConfig, logger.child("telegram"));
  const runtimeStatus = {
    lastCycle: null,
    memory: null
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
  let lastMemoryRecycleAt = 0;

  function refreshConfig() {
    effectiveConfig = applyRuntimeSettings(baseConfig, storage.getSettings());
    return effectiveConfig;
  }

  function browserRestartReason(config, now = Date.now()) {
    if (
      config.browserRestartIntervalMs > 0 &&
      browserStartedAt > 0 &&
      now - browserStartedAt >= config.browserRestartIntervalMs
    ) {
      const ageMinutes = Math.round((now - browserStartedAt) / 60000);
      return `scheduled recycle after ${ageMinutes}m`;
    }

    if (config.browserMemoryRecycleMb > 0) {
      const rssMb = Math.round(processTreeRssMb());
      runtimeStatus.memory = {
        processTreeRssMb: rssMb,
        thresholdMb: config.browserMemoryRecycleMb,
        cooldownMinutes: Math.round(config.browserMemoryRecycleCooldownMs / 60000),
        lastMemoryRecycleAt
      };

      const cooldownActive =
        lastMemoryRecycleAt > 0 && now - lastMemoryRecycleAt < config.browserMemoryRecycleCooldownMs;
      if (!cooldownActive && rssMb >= config.browserMemoryRecycleMb) {
        lastMemoryRecycleAt = now;
        return `memory recycle ${rssMb}MB >= ${config.browserMemoryRecycleMb}MB`;
      }
    }

    return "";
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
      storage.recordScanCycle(runtimeStatus.lastCycle);
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
    const recycleReason = browserRestartReason(effectiveConfig);
    if (recycleReason) {
      await openBrowserContext(recycleReason);
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
