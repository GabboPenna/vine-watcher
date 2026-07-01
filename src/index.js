"use strict";

const fs = require("fs");
const { createBrowserContext } = require("./browser");
const { loadConfig } = require("./config");
const { TelegramControl } = require("./control");
const { createLogger } = require("./logger");
const {
  formatEuro,
  isNotifyAllProductsActive,
  notificationBlockers,
  notificationTriggers
} = require("./notification-rules");
const { applyRuntimeSettings } = require("./runtime-config");
const { startHealthServer } = require("./health-server");
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
const { version } = require("../package.json");

function isPanicActive(config) {
  return Boolean(config.panicMode || (config.panicUntilMs && Date.now() < config.panicUntilMs));
}

function nextScanDelayMs(config, adaptiveState = null) {
  if (isPanicActive(config)) {
    return delayWithJitter(config.panicScanIntervalSeconds, config.panicScanJitterSeconds);
  }
  if (config.adaptiveScanEnabled && adaptiveState) {
    if (adaptiveState.activeCyclesRemaining > 0) {
      return delayWithJitter(config.adaptiveActiveIntervalSeconds, config.adaptiveActiveJitterSeconds);
    }
    if (adaptiveState.idleCycles >= config.adaptiveIdleAfterCycles) {
      return delayWithJitter(config.adaptiveIdleIntervalSeconds, config.scanJitterSeconds);
    }
  }
  return delayWithJitter(config.scanIntervalSeconds, config.scanJitterSeconds);
}

function nextScanReason(config, adaptiveState = null, overrideReason = "") {
  if (overrideReason) {
    return overrideReason;
  }
  if (isPanicActive(config)) {
    return "panic mode";
  }
  if (config.adaptiveScanEnabled && adaptiveState) {
    if (adaptiveState.activeCyclesRemaining > 0) {
      return "adaptive active";
    }
    if (adaptiveState.idleCycles >= config.adaptiveIdleAfterCycles) {
      return "adaptive idle";
    }
  }
  return "";
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

function safeConfigSnapshot(config) {
  return {
    scanIntervalSeconds: config.scanIntervalSeconds,
    scanJitterSeconds: config.scanJitterSeconds,
    adaptiveScanEnabled: config.adaptiveScanEnabled,
    panicActive: isPanicActive(config),
    notifyAllProducts: config.notifyAllProducts,
    notifyAllProductsWindow: config.notifyAllProductsWindow,
    minScoreToNotify: config.minScoreToNotify,
    minValueToNotifyEur: config.minValueToNotifyEur,
    strictNotifyMode: config.strictNotifyMode,
    strictMinPositiveSignals: config.strictMinPositiveSignals,
    strictMaxNegativeSignals: config.strictMaxNegativeSignals,
    maxNotificationsPerCycle: config.maxNotificationsPerCycle,
    sectionHardTimeoutMs: config.sectionHardTimeoutMs,
    sectionScanConcurrency: config.sectionScanConcurrency,
    reuseSectionPages: config.reuseSectionPages,
    detailValueLookupEnabled: config.detailValueLookupEnabled,
    detailValueLookupMaxPerCycle: config.detailValueLookupMaxPerCycle,
    scannerTurboOnlyDuringAdaptiveActive: config.scannerTurboOnlyDuringAdaptiveActive,
    scoringRulesLoaded: config.scoringRulesLoaded,
    sections: config.sections.map((section) => section.name)
  };
}

function hasEstimatedValue(product) {
  if (!product || product.estimated_value_eur === null || product.estimated_value_eur === undefined) {
    return false;
  }
  const parsed = Number(product.estimated_value_eur);
  return Number.isFinite(parsed) && parsed > 0;
}

function scoringCanNotify(scoring, config) {
  if (scoring.score < config.minScoreToNotify) {
    return false;
  }
  if (!config.strictNotifyMode) {
    return true;
  }
  return (
    scoring.positiveSignals >= config.strictMinPositiveSignals &&
    scoring.negativeSignals <= config.strictMaxNegativeSignals
  );
}

function layoutWarningsForSummary(summary, config, layoutHealthState = null) {
  const warnings = [];
  if (summary.scanned <= config.layoutHealthMinProducts) {
    warnings.push(
      `scanned ${summary.scanned} product(s), threshold=${config.layoutHealthMinProducts}; check Amazon layout/session`
    );
  }

  if (layoutHealthState && layoutHealthState.lowProductCycles >= config.layoutHealthWarnAfterCycles) {
    warnings.push(
      `low product count repeated for ${layoutHealthState.lowProductCycles} cycle(s); selectors may need review`
    );
  }

  return warnings;
}

function updateAdaptiveState(adaptiveState, summary, config) {
  if (!config.adaptiveScanEnabled) {
    adaptiveState.idleCycles = 0;
    adaptiveState.activeCyclesRemaining = 0;
    adaptiveState.lastReason = "";
    return adaptiveState;
  }

  const movement =
    Number(summary.newProducts || 0) > 0 ||
    Number(summary.notified || 0) > 0 ||
    Number(summary.disappearedProducts || 0) > 0;

  if (movement) {
    adaptiveState.idleCycles = 0;
    adaptiveState.activeCyclesRemaining = config.adaptiveActiveCycles;
    adaptiveState.lastReason = "movement";
    return adaptiveState;
  }

  adaptiveState.idleCycles += 1;
  adaptiveState.activeCyclesRemaining = Math.max(0, adaptiveState.activeCyclesRemaining - 1);
  adaptiveState.lastReason =
    adaptiveState.idleCycles >= config.adaptiveIdleAfterCycles ? "idle" : "normal";
  return adaptiveState;
}

function isAdaptiveActiveCycle(config, adaptiveState = null) {
  return Boolean(config.adaptiveScanEnabled && adaptiveState && adaptiveState.activeCyclesRemaining > 0);
}

function scannerConfigForCycle(config, adaptiveState = null) {
  const adaptiveActive = isAdaptiveActiveCycle(config, adaptiveState);
  if (!config.scannerTurboOnlyDuringAdaptiveActive || adaptiveActive) {
    return {
      config,
      adaptiveActive,
      turboEnabled: true
    };
  }

  return {
    config: {
      ...config,
      sectionScanConcurrency: 1,
      reuseSectionPages: false
    },
    adaptiveActive,
    turboEnabled: false
  };
}

async function runCycle({
  scanner,
  storage,
  telegram,
  config,
  logger,
  dryRun = false,
  layoutHealthState = null,
  adaptiveState = null
}) {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const inventoryAt = startedAtIso;
  const configSnapshot = safeConfigSnapshot(config);
  const scannerCycle = scannerConfigForCycle(config, adaptiveState);
  const scanConfig = scannerCycle.config;
  let scanned = 0;
  let newProducts = 0;
  let notified = 0;
  let dryRunMatches = 0;
  let disappearedProducts = 0;
  let maxScore = null;
  let skippedAlreadyNotified = 0;
  let skippedNoTrigger = 0;
  let skippedNotificationLimit = 0;
  let telegramFailures = 0;
  let detailValueLookups = 0;
  let detailValueLookupHits = 0;
  let detailValueLookupFailures = 0;
  const sections = [];

  if (scanner.config !== scanConfig) {
    scanner.config = scanConfig;
  }
  if (!scanConfig.reuseSectionPages && scanner.close) {
    await scanner.close();
  }
  if (config.scannerTurboOnlyDuringAdaptiveActive) {
    logger.info(
      scannerCycle.turboEnabled
        ? "Scanner turbo enabled for adaptive active cycle"
        : "Scanner turbo sleeping until adaptive active cycle"
    );
  }

  async function processSectionProducts(section, products) {
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

      const preliminaryExisting = storage.findExisting(product);
      const preliminaryNotified = preliminaryExisting && preliminaryExisting.notified === 1;
      let workingProduct = { ...product };
      if (!hasEstimatedValue(workingProduct) && hasEstimatedValue(preliminaryExisting)) {
        workingProduct.estimated_value_eur = preliminaryExisting.estimated_value_eur;
      }

      const detailLookupBudget = Math.max(0, Number(config.detailValueLookupMaxPerCycle || 0));
      const notifyAllActiveForLookup = isNotifyAllProductsActive(config);
      const valueLookupCanUnlockNotification = !preliminaryExisting && config.minValueToNotifyEur > 0;
      const shouldLookupDetailValue =
        Boolean(config.detailValueLookupEnabled) &&
        detailValueLookups < detailLookupBudget &&
        !preliminaryNotified &&
        !hasEstimatedValue(workingProduct) &&
        Boolean(workingProduct.vine_recommendation_id) &&
        typeof scanner.enrichProductValue === "function" &&
        (valueLookupCanUnlockNotification || notifyAllActiveForLookup || scoringCanNotify(scoring, config));

      if (shouldLookupDetailValue) {
        detailValueLookups += 1;
        try {
          const enrichedProduct = await scanner.enrichProductValue(workingProduct);
          if (hasEstimatedValue(enrichedProduct)) {
            workingProduct = enrichedProduct;
            detailValueLookupHits += 1;
            logger.info(
              `Vine detail value found value=${formatEuro(workingProduct.estimated_value_eur)} ` +
                `section="${workingProduct.section}" title="${workingProduct.title}"`
            );
          }
        } catch (error) {
          detailValueLookupFailures += 1;
          logger.warn(`Vine detail value lookup failed for "${workingProduct.title}": ${error.message}`);
        }
      }

      const triggers = notificationTriggers(workingProduct, scoring, config);
      const blockers = notificationBlockers(workingProduct, scoring, config, preliminaryNotified);
      const hasTrigger = triggers.length > 0;
      const preliminaryDecision = preliminaryNotified ? "already_notified" : hasTrigger ? "candidate" : "no_trigger";
      const saved = storage.saveProduct(workingProduct, scoring, {
        inventoryAt,
        triggers,
        blockers,
        configSnapshot,
        decision: preliminaryDecision
      });
      if (saved.isNew) {
        newProducts += 1;
        logger.info(
          `New product score=${scoring.score} value=${formatEuro(workingProduct.estimated_value_eur)} ` +
            `section="${workingProduct.section}" title="${workingProduct.title}"`
        );
      }

      const shouldNotify = saved.product.notified !== 1 && triggers.length > 0;
      if (!shouldNotify) {
        storage.saveProduct(saved.product, scoring, {
          inventoryAt,
          triggers,
          blockers: notificationBlockers(saved.product, scoring, config, saved.product.notified === 1),
          configSnapshot,
          decision: saved.product.notified === 1 ? "already_notified" : "no_trigger"
        });
        if (saved.product.notified === 1) {
          skippedAlreadyNotified += 1;
        } else {
          skippedNoTrigger += 1;
        }
        continue;
      }

      if (notified >= config.maxNotificationsPerCycle) {
        skippedNotificationLimit += 1;
        storage.saveProduct(saved.product, scoring, {
          inventoryAt,
          triggers,
          blockers: ["notification limit reached"],
          configSnapshot,
          decision: "notification_limit"
        });
        logger.warn(
          `Notification limit reached; not notifying score=${scoring.score} ` +
            `value=${formatEuro(saved.product.estimated_value_eur)} title="${workingProduct.title}"`
        );
        continue;
      }

      try {
        const sent = dryRun
          ? true
          : await telegram.sendProduct(saved.product, {
              ...scoring,
              notificationTriggers: triggers
            });
        if (sent) {
          if (dryRun) {
            dryRunMatches += 1;
            logger.info(
              `DRY RUN would notify product id=${saved.product.id} score=${scoring.score} ` +
                `value=${formatEuro(saved.product.estimated_value_eur)} triggers="${triggers.join("; ")}"`
            );
          } else {
            storage.markNotified(saved.product.id);
            notified += 1;
            logger.info(
              `Telegram notification sent for product id=${saved.product.id} score=${scoring.score} ` +
                `value=${formatEuro(saved.product.estimated_value_eur)} triggers="${triggers.join("; ")}"`
            );
          }
          storage.saveProduct(saved.product, scoring, {
            inventoryAt,
            triggers,
            blockers: ["no blockers"],
            configSnapshot,
            decision: dryRun ? "dry_run_would_notify" : "notified"
          });
        }
      } catch (error) {
        telegramFailures += 1;
        storage.saveProduct(saved.product, scoring, {
          inventoryAt,
          triggers,
          blockers: [error.message],
          configSnapshot,
          decision: "telegram_failed"
        });
        logger.error(`Telegram notification failed for product id=${saved.product.id}: ${error.message}`);
      }
    }

  }

  async function scanSection(section) {
    const products = await scanner.scanSection(section);
    return {
      section,
      products
    };
  }

  const sectionScanConcurrency = Math.max(1, Math.floor(Number(scanConfig.sectionScanConcurrency || 1)));
  if (sectionScanConcurrency <= 1 || scanConfig.sections.length <= 1) {
    for (const section of scanConfig.sections) {
      const result = await scanSection(section);
      await processSectionProducts(result.section, result.products);
      if (scanConfig.sectionDelayMs > 0) {
        await sleep(scanConfig.sectionDelayMs);
      }
    }
  } else {
    const queue = [...scanConfig.sections];
    const active = new Set();
    const concurrency = Math.min(sectionScanConcurrency, queue.length);

    logger.info(`Scanning up to ${concurrency} Vine sections in parallel`);

    function startNextSection() {
      if (queue.length === 0 || active.size >= concurrency) {
        return;
      }
      const section = queue.shift();
      const promise = scanSection(section)
        .then((result) => ({
          promise,
          result
        }))
        .catch((error) => ({
          promise,
          error,
          section
        }));
      active.add(promise);
    }

    while (active.size < concurrency && queue.length > 0) {
      startNextSection();
    }

    while (active.size > 0) {
      const settled = await Promise.race(active);
      active.delete(settled.promise);
      if (settled.error) {
        throw settled.error;
      }
      await processSectionProducts(settled.result.section, settled.result.products);
      if (scanConfig.sectionDelayMs > 0 && queue.length > 0) {
        await sleep(scanConfig.sectionDelayMs);
      }
      startNextSection();
    }
  }

  disappearedProducts = storage.markMissingProducts(inventoryAt);
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  let outcome = "no_notifications";
  let reasonNoNotifications = "";
  if (notified > 0) {
    outcome = "sent_notifications";
    reasonNoNotifications = "sent notifications";
  } else if (dryRunMatches > 0) {
    outcome = "dry_run_matches";
    reasonNoNotifications = "dry-run found matching products";
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

  const summary = {
    startedAt: startedAtIso,
    completedAt: new Date().toISOString(),
    scanned,
    newProducts,
    notified,
    dryRunMatches,
    disappearedProducts,
    maxScore: maxScore === null ? "n/d" : maxScore,
    elapsedSeconds,
    skippedAlreadyNotified,
    skippedNoTrigger,
    skippedNotificationLimit,
    telegramFailures,
    detailValueLookups,
    detailValueLookupHits,
    detailValueLookupFailures,
    dryRun,
    outcome,
    reasonNoNotifications,
    sections
  };
  summary.layoutWarnings = layoutWarningsForSummary(summary, config, layoutHealthState);

  logger.info(
    `Cycle complete: scanned=${scanned} new=${newProducts} gone=${disappearedProducts} notified=${notified} max_score=${
      maxScore === null ? "n/d" : maxScore
    } detail_value=${detailValueLookupHits}/${detailValueLookups} failed=${detailValueLookupFailures} ` +
      `elapsed=${elapsedSeconds}s outcome=${outcome}`
  );
  if (summary.layoutWarnings.length > 0) {
    logger.warn(`Layout health warning: ${summary.layoutWarnings.join("; ")}`);
  }

  return summary;
}

async function main() {
  const once = process.argv.includes("--once");
  const dryRun = process.argv.includes("--dry-run");
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
  let lastMaintenanceAt = 0;
  let healthServer = null;
  const adaptiveState = {
    idleCycles: 0,
    activeCyclesRemaining: 0,
    lastReason: ""
  };
  const layoutHealthState = {
    lowProductCycles: 0
  };

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
      if (scanner && scanner.close) {
        await scanner.close().catch((error) => logger.warn(`Scanner page cleanup failed: ${error.message}`));
      }
      await context.close().catch((error) => logger.warn(`Browser close failed: ${error.message}`));
      context = null;
      scanner = null;
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
    if (healthServer) {
      await new Promise((resolve) => healthServer.close(resolve)).catch(() => {});
    }
    if (scanner && scanner.close) {
      await scanner.close().catch((error) => logger.warn(`Scanner page cleanup failed: ${error.message}`));
      scanner = null;
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
  healthServer = startHealthServer({
    config: effectiveConfig,
    storage,
    getStatus: () => runtimeStatus,
    logger: logger.child("health"),
    version
  });
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
  if (dryRun) {
    logger.warn("Dry-run mode enabled: matching products are logged but Telegram notifications are not sent");
  }

  do {
    refreshConfig();
    scanner.config = effectiveConfig;
    try {
      runtimeStatus.lastCycle = await runCycle({
        scanner,
        storage,
        telegram,
        config: effectiveConfig,
        logger,
        dryRun,
        layoutHealthState,
        adaptiveState
      });
      storage.recordScanCycle(runtimeStatus.lastCycle);
      if (runtimeStatus.lastCycle.scanned <= effectiveConfig.layoutHealthMinProducts) {
        layoutHealthState.lowProductCycles += 1;
      } else {
        layoutHealthState.lowProductCycles = 0;
      }
      updateAdaptiveState(adaptiveState, runtimeStatus.lastCycle, effectiveConfig);
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
    const now = Date.now();
    if (
      effectiveConfig.sqliteVacuumIntervalHours > 0 &&
      now - lastMaintenanceAt >= effectiveConfig.sqliteVacuumIntervalHours * 60 * 60 * 1000
    ) {
      const maintenance = storage.cleanup({
        productDays: effectiveConfig.retentionProductsDays,
        scanCycleDays: effectiveConfig.retentionScanCyclesDays,
        vacuum: true
      });
      lastMaintenanceAt = now;
      logger.info(
        `SQLite maintenance complete: deleted_products=${maintenance.deletedProducts} ` +
          `deleted_cycles=${maintenance.deletedScanCycles} vacuumed=${maintenance.vacuumed}`
      );
    }

    const recycleReason = browserRestartReason(effectiveConfig);
    if (recycleReason) {
      await openBrowserContext(recycleReason);
    } else {
      scanner.config = effectiveConfig;
    }
    const waitMs =
      nextDelayOverrideMs > 0 ? nextDelayOverrideMs : nextScanDelayMs(effectiveConfig, adaptiveState);
    const reason = nextScanReason(effectiveConfig, adaptiveState, nextDelayReason);
    const waitReason = reason ? ` (${reason})` : "";
    nextDelayOverrideMs = 0;
    nextDelayReason = "";
    logger.info(`Next scan in ${Math.round(waitMs / 1000)}s${waitReason}`);
    await sleep(waitMs);
  } while (!shuttingDown);

  if (context) {
    if (scanner && scanner.close) {
      await scanner.close().catch((error) => logger.warn(`Scanner page cleanup failed: ${error.message}`));
    }
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
  nextScanDelayMs,
  runCycle,
  safeConfigSnapshot,
  scannerConfigForCycle,
  shouldDeferSessionAttention
};
