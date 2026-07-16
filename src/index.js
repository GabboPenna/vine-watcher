"use strict";

const fs = require("fs");
const { createBrowserContext } = require("./browser");
const { loadConfig, validateConfig } = require("./config");
const { TelegramControl } = require("./control");
const { createLogger } = require("./logger");
const { runSqliteMaintenance } = require("./maintenance");
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
const {
  isPanicActive,
  memoryRecycleThresholdMb,
  nextScanDelayMs,
  nextScanReason,
  scannerConfigForCycle,
  updateAdaptiveState
} = require("./scheduler");
const { isTimeWindowActive } = require("./time-window");
const { sleep } = require("./utils");
const { TelegramClient } = require("./telegram");
const { version } = require("../package.json");

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

function isTransientScanError(error) {
  const message = error && error.message ? error.message : String(error || "");
  return (
    (error && (error.name === "SectionScanTimeoutError" || error.name === "SectionPageInvalidError")) ||
    /page\.goto:.*Timeout/i.test(message) ||
    /TimeoutError:.*page\.goto/i.test(message) ||
    /net::ERR_/i.test(message) ||
    /exceeded hard timeout/i.test(message) ||
    /Amazon returned HTTP (?:429|5\d\d)/i.test(message)
  );
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
    sectionNavigationRetries: config.sectionNavigationRetries,
    transientScanMaxFailures: config.transientScanMaxFailures,
    sectionScanConcurrency: config.sectionScanConcurrency,
    reuseSectionPages: config.reuseSectionPages,
    browserMemoryRecycleMinGrowthMb: config.browserMemoryRecycleMinGrowthMb,
    detailValueLookupEnabled: config.detailValueLookupEnabled,
    detailValueLookupMaxPerCycle: config.detailValueLookupMaxPerCycle,
    detailValueLookupMinIntervalMs: config.detailValueLookupMinIntervalMs,
    detailValueLookupRetryBaseMs: config.detailValueLookupRetryBaseMs,
    detailValueLookupRetryMaxMs: config.detailValueLookupRetryMaxMs,
    scannerTurboOnlyDuringAdaptiveActive: config.scannerTurboOnlyDuringAdaptiveActive,
    scoringRulesLoaded: config.scoringRulesLoaded,
    sections: config.sections.map((section) => section.name)
  };
}

function failedCycleSummary(startedAt, error, failureKind = "error") {
  const completedAt = Date.now();
  const startedAtMs = Number(startedAt) || completedAt;
  const message = error && error.message ? error.message : String(error || "Unknown error");
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    scanned: 0,
    newProducts: 0,
    notified: 0,
    dryRunMatches: 0,
    disappearedProducts: 0,
    maxScore: "n/d",
    elapsedSeconds: ((completedAt - startedAtMs) / 1000).toFixed(1),
    skippedAlreadyNotified: 0,
    skippedNoTrigger: 0,
    skippedNotificationLimit: 0,
    telegramFailures: 0,
    detailValueLookups: 0,
    detailValueLookupHits: 0,
    detailValueLookupFailures: 0,
    sectionFailures: [],
    dryRun: false,
    success: false,
    failureKind,
    error: message,
    outcome: failureKind,
    reasonNoNotifications: message,
    sections: [],
    layoutWarnings: [message]
  };
}

function hasEstimatedValue(product) {
  if (!product || product.estimated_value_eur === null || product.estimated_value_eur === undefined) {
    return false;
  }
  const parsed = Number(product.estimated_value_eur);
  return Number.isFinite(parsed) && parsed > 0;
}

function isValueLookupDue(product, now = Date.now()) {
  if (hasEstimatedValue(product)) {
    return false;
  }
  const nextAt = Date.parse(String((product && product.value_lookup_next_at) || ""));
  return !Number.isFinite(nextAt) || nextAt <= now;
}

function nextValueLookupRetryAt(product, config, now = Date.now()) {
  const attempts = Math.max(0, Number((product && product.value_lookup_attempts) || 0));
  const baseMs = Math.max(1000, Number(config.detailValueLookupRetryBaseMs) || 60000);
  const maxMs = Math.max(baseMs, Number(config.detailValueLookupRetryMaxMs) || 3600000);
  const delayMs = Math.min(maxMs, baseMs * 2 ** Math.min(attempts, 8));
  return new Date(now + delayMs).toISOString();
}

function storedTelegramMessage(product) {
  if (!product || !product.telegram_message_id) {
    return null;
  }
  return {
    chatId: product.telegram_chat_id || undefined,
    messageId: Number(product.telegram_message_id),
    kind: product.telegram_message_kind || "message"
  };
}

function layoutWarningsForSummary(summary, config, layoutHealthState = null) {
  const warnings = [];
  if (summary.sectionFailures && summary.sectionFailures.length > 0) {
    warnings.push(
      `section failure(s): ${summary.sectionFailures
        .map((failure) => `${failure.section}: ${failure.error}`)
        .join("; ")}`
    );
  }

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

async function runCycle({
  scanner,
  storage,
  telegram,
  config,
  logger,
  dryRun = false,
  layoutHealthState = null,
  adaptiveState = null,
  valueLookupState = null
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
  const successfulSectionNames = [];
  const sectionFailures = [];
  const lookupRateState = valueLookupState || { lastAttemptAt: 0 };

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

  async function lookupDetailValue(valueProduct) {
    const detailLookupBudget = Math.max(0, Number(config.detailValueLookupMaxPerCycle || 0));
    const minLookupIntervalMs = Math.max(0, Number(config.detailValueLookupMinIntervalMs || 0));
    const now = Date.now();
    if (
      !config.detailValueLookupEnabled ||
      detailValueLookups >= detailLookupBudget ||
      (minLookupIntervalMs > 0 &&
        lookupRateState.lastAttemptAt > 0 &&
        now - lookupRateState.lastAttemptAt < minLookupIntervalMs) ||
      hasEstimatedValue(valueProduct) ||
      !valueProduct.vine_recommendation_id ||
      typeof scanner.enrichProductValue !== "function" ||
      !isValueLookupDue(valueProduct)
    ) {
      return {
        product: valueProduct,
        attempted: false,
        found: hasEstimatedValue(valueProduct),
        error: null
      };
    }

    detailValueLookups += 1;
    lookupRateState.lastAttemptAt = now;
    try {
      const enrichedProduct = await scanner.enrichProductValue(valueProduct);
      if (hasEstimatedValue(enrichedProduct)) {
        detailValueLookupHits += 1;
        logger.info(
          `Vine detail value found value=${formatEuro(enrichedProduct.estimated_value_eur)} ` +
            `section="${enrichedProduct.section}" title="${enrichedProduct.title}"`
        );
        return {
          product: enrichedProduct,
          attempted: true,
          found: true,
          error: null
        };
      }
      return {
        product: valueProduct,
        attempted: true,
        found: false,
        error: null
      };
    } catch (error) {
      detailValueLookupFailures += 1;
      logger.warn(`Vine detail value lookup failed for "${valueProduct.title}": ${error.message}`);
      return {
        product: valueProduct,
        attempted: true,
        found: false,
        error
      };
    }
  }

  function recordDetailLookup(product, lookupResult) {
    if (!lookupResult || !lookupResult.attempted || !product || !product.id) {
      return product;
    }
    if (typeof storage.recordValueLookupAttempt !== "function") {
      return product;
    }
    const recorded = storage.recordValueLookupAttempt(product.id, {
      found: lookupResult.found,
      error: Boolean(lookupResult.error),
      nextAt: lookupResult.found ? null : nextValueLookupRetryAt(product, config)
    });
    if (!recorded) {
      return product;
    }
    return {
      ...recorded,
      ...product,
      value_lookup_attempts: recorded.value_lookup_attempts,
      value_lookup_last_at: recorded.value_lookup_last_at,
      value_lookup_next_at: recorded.value_lookup_next_at,
      value_lookup_status: recorded.value_lookup_status
    };
  }

  async function processSectionProducts(section, products) {
    scanned += products.length;
    sections.push({
      name: section.name,
      scanned: products.length
    });
    successfulSectionNames.push(section.name);

    for (const product of products) {
      const scoring = scoreProduct(product, config.keywords);
      if (maxScore === null || scoring.score > maxScore) {
        maxScore = scoring.score;
      }

      const preliminaryExisting = storage.findExisting(product);
      const preliminaryNotified = preliminaryExisting && preliminaryExisting.notified === 1;
      let workingProduct = { ...(preliminaryExisting || {}), ...product };
      if (!hasEstimatedValue(workingProduct) && hasEstimatedValue(preliminaryExisting)) {
        workingProduct.estimated_value_eur = preliminaryExisting.estimated_value_eur;
      }

      let triggers = notificationTriggers(workingProduct, scoring, config);
      const valueLookupCanUnlockNotification =
        !preliminaryNotified &&
        triggers.length === 0 &&
        config.minValueToNotifyEur > 0 &&
        isValueLookupDue(workingProduct);
      let preliminaryLookup = null;

      if (valueLookupCanUnlockNotification) {
        preliminaryLookup = await lookupDetailValue(workingProduct);
        workingProduct = preliminaryLookup.product;
        triggers = notificationTriggers(workingProduct, scoring, config);
      }

      const blockers = notificationBlockers(workingProduct, scoring, config, preliminaryNotified);
      const hasTrigger = triggers.length > 0;
      const preliminaryDecision = preliminaryNotified ? "already_notified" : hasTrigger ? "candidate" : "no_trigger";
      let saved = storage.saveProduct(workingProduct, scoring, {
        inventoryAt,
        triggers,
        blockers,
        configSnapshot,
        decision: preliminaryDecision
      });
      if (preliminaryLookup && preliminaryLookup.attempted) {
        saved.product = recordDetailLookup(saved.product, preliminaryLookup);
      }
      if (saved.isNew) {
        newProducts += 1;
        logger.info(
          `New product score=${scoring.score} value=${formatEuro(workingProduct.estimated_value_eur)} ` +
            `section="${workingProduct.section}" title="${workingProduct.title}"`
        );
      }

      const shouldNotify = saved.product.notified !== 1 && triggers.length > 0;
      if (!shouldNotify) {
        if (
          saved.product.notified === 1 &&
          !hasEstimatedValue(saved.product) &&
          saved.product.vine_recommendation_id &&
          isValueLookupDue(saved.product)
        ) {
          const backgroundLookup = await lookupDetailValue(saved.product);
          if (backgroundLookup.attempted) {
            if (backgroundLookup.found) {
              const enrichedSaved = storage.saveProduct(backgroundLookup.product, scoring, {
                inventoryAt,
                triggers: notificationTriggers(backgroundLookup.product, scoring, config),
                blockers: ["already notified"],
                configSnapshot,
                decision: "already_notified_value_enriched"
              });
              saved.product = enrichedSaved.product;
              const sentMessage = storedTelegramMessage(saved.product);
              if (sentMessage && typeof telegram.editProductNotification === "function") {
                await telegram
                  .editProductNotification(sentMessage, saved.product, {
                    ...scoring,
                    notificationTriggers: notificationTriggers(saved.product, scoring, config)
                  })
                  .catch((editError) => {
                    logger.warn(
                      `Deferred Telegram value update failed for product id=${saved.product.id}: ${editError.message}`
                    );
                  });
              }
            }
            saved.product = recordDetailLookup(saved.product, backgroundLookup);
          }
        }

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
        const notificationProduct =
          !hasEstimatedValue(saved.product) &&
          saved.product.vine_recommendation_id &&
          config.detailValueLookupEnabled
            ? { ...saved.product, value_lookup_pending: true }
            : saved.product;
        const sent = dryRun
          ? true
          : await telegram.sendProduct(notificationProduct, {
              ...scoring,
              notificationTriggers: triggers
            });
        if (sent) {
          let finalProduct = saved.product;
          let finalTriggers = triggers;

          if (dryRun) {
            dryRunMatches += 1;
            logger.info(
              `DRY RUN would notify product id=${saved.product.id} score=${scoring.score} ` +
                `value=${formatEuro(saved.product.estimated_value_eur)} triggers="${triggers.join("; ")}"`
            );
          } else {
            const markedProduct = storage.markNotified(saved.product.id, sent);
            if (markedProduct) {
              saved.product = markedProduct;
            }
            notified += 1;
            logger.info(
              `Telegram notification sent for product id=${saved.product.id} score=${scoring.score} ` +
                `value=${formatEuro(saved.product.estimated_value_eur)} triggers="${triggers.join("; ")}"`
            );

            if (
              !hasEstimatedValue(saved.product) &&
              saved.product.vine_recommendation_id &&
              isValueLookupDue(saved.product)
            ) {
              const postNotificationLookup = await lookupDetailValue(saved.product);
              if (postNotificationLookup.attempted && postNotificationLookup.found) {
                finalProduct = postNotificationLookup.product;
                finalTriggers = notificationTriggers(finalProduct, scoring, config);
                if (typeof telegram.editProductNotification === "function") {
                  await telegram
                    .editProductNotification(sent, finalProduct, {
                      ...scoring,
                      notificationTriggers: finalTriggers
                    })
                    .catch((editError) => {
                      logger.warn(`Telegram value update failed for product id=${saved.product.id}: ${editError.message}`);
                    });
                }
              }
              finalProduct = recordDetailLookup(finalProduct, postNotificationLookup);
            }
          }
          storage.saveProduct(finalProduct, scoring, {
            inventoryAt,
            triggers: finalTriggers,
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

  function recordSectionFailure(section, error) {
    sectionFailures.push({
      section,
      error
    });
    sections.push({
      name: section.name,
      scanned: 0,
      error: error && error.message ? error.message : String(error)
    });
    logger.warn(
      `Section "${section.name}" failed this cycle and will be skipped: ${
        error && error.message ? error.message : String(error)
      }`
    );
  }

  const sectionScanConcurrency = Math.max(1, Math.floor(Number(scanConfig.sectionScanConcurrency || 1)));
  if (sectionScanConcurrency <= 1 || scanConfig.sections.length <= 1) {
    for (const section of scanConfig.sections) {
      try {
        const result = await scanSection(section);
        await processSectionProducts(result.section, result.products);
      } catch (error) {
        if (error instanceof SessionNeedsAttentionError) {
          throw error;
        }
        recordSectionFailure(section, error);
      }
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
        if (settled.error instanceof SessionNeedsAttentionError) {
          queue.length = 0;
          if (typeof scanner.cancelActiveScans === "function") {
            await scanner.cancelActiveScans("Amazon session needs attention");
          }
          await Promise.all(active);
          throw settled.error;
        }
        recordSectionFailure(settled.section, settled.error);
      } else {
        await processSectionProducts(settled.result.section, settled.result.products);
      }
      if (scanConfig.sectionDelayMs > 0 && queue.length > 0) {
        await sleep(scanConfig.sectionDelayMs);
      }
      startNextSection();
    }
  }

  if (sectionFailures.length > 0 && successfulSectionNames.length === 0) {
    throw sectionFailures[0].error;
  }

  const missingSectionFilter = sectionFailures.length > 0 ? successfulSectionNames : null;
  disappearedProducts = storage.markMissingProducts(inventoryAt, missingSectionFilter);
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
  } else if (sectionFailures.length > 0) {
    outcome = "partial_scan";
    reasonNoNotifications = "one or more sections failed but the cycle continued";
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
    sectionFailures: sectionFailures.map((failure) => ({
      section: failure.section.name,
      error: failure.error && failure.error.message ? failure.error.message : String(failure.error)
    })),
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
    startedAt: Date.now(),
    lastSuccessfulCycleAt: 0,
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
  let consecutiveTransientScanFailures = 0;
  let lastKnownGoodSessionAt = Date.now();
  let nextDelayOverrideMs = 0;
  let nextDelayReason = "";
  let lastMemoryRecycleAt = 0;
  let browserBaselineRssMb = 0;
  let lastMaintenanceAt = Date.now();
  let maintenancePromise = null;
  let healthServer = null;
  const adaptiveState = {
    idleCycles: 0,
    activeCyclesRemaining: 0,
    lastReason: ""
  };
  const layoutHealthState = {
    lowProductCycles: 0
  };
  const valueLookupState = {
    lastAttemptAt: 0
  };

  function refreshConfig() {
    effectiveConfig = validateConfig(applyRuntimeSettings(baseConfig, storage.getSettings()));
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
      if (browserBaselineRssMb <= 0 || rssMb < browserBaselineRssMb) {
        browserBaselineRssMb = rssMb;
      }
      const effectiveThresholdMb = memoryRecycleThresholdMb(config, browserBaselineRssMb);
      runtimeStatus.memory = {
        processTreeRssMb: rssMb,
        thresholdMb: config.browserMemoryRecycleMb,
        baselineMb: browserBaselineRssMb,
        effectiveThresholdMb,
        cooldownMinutes: Math.round(config.browserMemoryRecycleCooldownMs / 60000),
        lastMemoryRecycleAt
      };

      const cooldownActive =
        lastMemoryRecycleAt > 0 && now - lastMemoryRecycleAt < config.browserMemoryRecycleCooldownMs;
      if (!cooldownActive && rssMb >= effectiveThresholdMb) {
        return `memory recycle ${rssMb}MB >= ${effectiveThresholdMb}MB ` +
          `(configured=${config.browserMemoryRecycleMb}MB baseline=${browserBaselineRssMb}MB)`;
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
    browserBaselineRssMb = 0;
    if (String(reason).startsWith("memory recycle")) {
      lastMemoryRecycleAt = browserStartedAt;
    }
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
    if (maintenancePromise) {
      await Promise.race([maintenancePromise.catch(() => {}), sleep(5000)]);
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
    getConfig: () => refreshConfig(),
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
    const cycleStartedAt = Date.now();
    let cycleFailureKind = "runtime_error";
    let cycleFailureRecorded = false;
    const recordCycleFailure = (error) => {
      if (cycleFailureRecorded || (shuttingDown && isBrowserClosedError(error))) {
        return;
      }
      runtimeStatus.lastCycle = {
        ...failedCycleSummary(cycleStartedAt, error, cycleFailureKind),
        dryRun
      };
      storage.recordScanCycle(runtimeStatus.lastCycle);
      cycleFailureRecorded = true;
    };
    try {
      runtimeStatus.lastCycle = await runCycle({
        scanner,
        storage,
        telegram,
        config: effectiveConfig,
        logger,
        dryRun,
        layoutHealthState,
        adaptiveState,
        valueLookupState
      });
      storage.recordScanCycle(runtimeStatus.lastCycle);
      if (runtimeStatus.lastCycle.scanned <= effectiveConfig.layoutHealthMinProducts) {
        layoutHealthState.lowProductCycles += 1;
      } else {
        layoutHealthState.lowProductCycles = 0;
      }
      updateAdaptiveState(adaptiveState, runtimeStatus.lastCycle, effectiveConfig);
      consecutiveSessionAttentionFailures = 0;
      consecutiveTransientScanFailures = 0;
      lastKnownGoodSessionAt = Date.now();
      runtimeStatus.lastSuccessfulCycleAt = lastKnownGoodSessionAt;
    } catch (error) {
      if (error instanceof SessionNeedsAttentionError) {
        cycleFailureKind = `session_${error.kind || "attention"}`;
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
          cycleFailureKind = "session_attention_not_confirmed";
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
            recordCycleFailure(error);
            await shutdown("session attention", once ? 2 : 0);
            return;
          }
        }
      } else if (shuttingDown && isBrowserClosedError(error)) {
        cycleFailureKind = "shutdown_interrupted";
        logger.info("Scan interrupted by shutdown");
      } else if (isTransientScanError(error)) {
        cycleFailureKind = "transient_scan_failure";
        consecutiveTransientScanFailures += 1;
        nextDelayOverrideMs = Math.max(nextDelayOverrideMs, effectiveConfig.transientScanBackoffMs);
        nextDelayReason = "transient scan backoff";

        const maxFailures = effectiveConfig.transientScanMaxFailures;
        const shouldNotify =
          consecutiveTransientScanFailures >= maxFailures &&
          effectiveConfig.notifyCriticalErrors &&
          Date.now() - lastCriticalNotificationAt > effectiveConfig.criticalNotificationCooldownMs;

        logger.warn(
          `Transient scan failure ${consecutiveTransientScanFailures}/${maxFailures}: ${error.message}; ` +
            `backing off for ${Math.round(effectiveConfig.transientScanBackoffMs / 1000)}s`
        );

        if (shouldNotify) {
          lastCriticalNotificationAt = Date.now();
          const notificationError = new Error(
            [
              error.message,
              "",
              `Transient scan failures: ${consecutiveTransientScanFailures}/${maxFailures}`,
              "The watcher will keep retrying with backoff."
            ].join("\n")
          );
          await telegram.sendCriticalError(notificationError).catch((telegramError) => {
            logger.warn(`Critical Telegram notification failed: ${telegramError.message}`);
          });
        }
      } else {
        cycleFailureKind = "runtime_error";
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
      recordCycleFailure(error);
    }

    if (once || shuttingDown) {
      break;
    }

    refreshConfig();
    const now = Date.now();
    if (
      effectiveConfig.sqliteVacuumIntervalHours > 0 &&
      !maintenancePromise &&
      now - lastMaintenanceAt >= effectiveConfig.sqliteVacuumIntervalHours * 60 * 60 * 1000
    ) {
      lastMaintenanceAt = now;
      maintenancePromise = runSqliteMaintenance(effectiveConfig)
        .then((maintenance) => {
          logger.info(
            `SQLite maintenance complete: deleted_products=${maintenance.deletedProducts} ` +
              `deleted_cycles=${maintenance.deletedScanCycles} checkpointed=${maintenance.checkpointed} ` +
              `vacuumed=${maintenance.vacuumed}`
          );
        })
        .catch((error) => {
          logger.warn(`SQLite maintenance failed: ${error.message}`);
        })
        .finally(() => {
          maintenancePromise = null;
        });
    }

    const recycleReason = browserRestartReason(effectiveConfig);
    scanner.config = effectiveConfig;
    const waitMs =
      nextDelayOverrideMs > 0 ? nextDelayOverrideMs : nextScanDelayMs(effectiveConfig, adaptiveState);
    const reason = nextScanReason(effectiveConfig, adaptiveState, nextDelayReason);
    const waitReason = reason ? ` (${reason})` : "";
    nextDelayOverrideMs = 0;
    nextDelayReason = "";
    logger.info(`Next scan in ${Math.round(waitMs / 1000)}s${waitReason}`);
    await sleep(waitMs);
    if (recycleReason && !shuttingDown) {
      await openBrowserContext(recycleReason);
    }
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
  if (maintenancePromise) {
    await Promise.race([maintenancePromise.catch(() => {}), sleep(5000)]);
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
  isTransientScanError,
  isTimeWindowActive,
  notificationTriggers,
  nextScanDelayMs,
  runCycle,
  safeConfigSnapshot,
  scannerConfigForCycle,
  shouldDeferSessionAttention
};
