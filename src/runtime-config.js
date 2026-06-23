"use strict";

const CONTROL_OFFSET_KEY = "telegram_control_update_offset";

const USER_SETTING_KEYS = [
  "control_language",
  "notify_all_products",
  "notify_all_products_window",
  "min_score_to_notify",
  "min_value_to_notify_eur",
  "strict_notify_mode",
  "strict_min_positive_signals",
  "strict_max_negative_signals",
  "max_notifications_per_cycle",
  "panic_mode",
  "panic_until_ms",
  "panic_scan_interval_seconds",
  "panic_scan_jitter_seconds",
  "scan_interval_seconds",
  "scan_jitter_seconds",
  "page_timeout_seconds",
  "product_ready_timeout_seconds",
  "page_settle_seconds",
  "section_delay_seconds",
  "browser_restart_interval_minutes",
  "browser_memory_recycle_mb",
  "browser_memory_recycle_cooldown_minutes"
];

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback, min = undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (min !== undefined) {
    return Math.max(min, parsed);
  }
  return parsed;
}

function normalizeLanguage(value, fallback = "en") {
  const language = String(value || "").trim().toLowerCase();
  return language === "it" || language === "en" ? language : fallback;
}

function applyRuntimeSettings(baseConfig, settings = {}) {
  const config = { ...baseConfig };

  if (settings.notify_all_products !== undefined) {
    config.notifyAllProducts = parseBool(settings.notify_all_products, config.notifyAllProducts);
  }
  if (settings.notify_all_products_window !== undefined) {
    config.notifyAllProductsWindow = String(settings.notify_all_products_window || "").trim();
  }
  if (settings.min_score_to_notify !== undefined) {
    config.minScoreToNotify = parseNumber(settings.min_score_to_notify, config.minScoreToNotify);
  }
  if (settings.min_value_to_notify_eur !== undefined) {
    config.minValueToNotifyEur = parseNumber(settings.min_value_to_notify_eur, config.minValueToNotifyEur, 0);
  }
  if (settings.strict_notify_mode !== undefined) {
    config.strictNotifyMode = parseBool(settings.strict_notify_mode, config.strictNotifyMode);
  }
  if (settings.strict_min_positive_signals !== undefined) {
    config.strictMinPositiveSignals = parseNumber(
      settings.strict_min_positive_signals,
      config.strictMinPositiveSignals,
      0
    );
  }
  if (settings.strict_max_negative_signals !== undefined) {
    config.strictMaxNegativeSignals = parseNumber(
      settings.strict_max_negative_signals,
      config.strictMaxNegativeSignals,
      0
    );
  }
  if (settings.max_notifications_per_cycle !== undefined) {
    config.maxNotificationsPerCycle = parseNumber(
      settings.max_notifications_per_cycle,
      config.maxNotificationsPerCycle,
      1
    );
  }
  if (settings.panic_mode !== undefined) {
    config.panicMode = parseBool(settings.panic_mode, config.panicMode);
  }
  if (settings.panic_until_ms !== undefined) {
    config.panicUntilMs = parseNumber(settings.panic_until_ms, config.panicUntilMs, 0);
  }
  if (settings.panic_scan_interval_seconds !== undefined) {
    config.panicScanIntervalSeconds = parseNumber(
      settings.panic_scan_interval_seconds,
      config.panicScanIntervalSeconds,
      5
    );
  }
  if (settings.panic_scan_jitter_seconds !== undefined) {
    config.panicScanJitterSeconds = parseNumber(
      settings.panic_scan_jitter_seconds,
      config.panicScanJitterSeconds,
      0
    );
  }
  if (settings.scan_interval_seconds !== undefined) {
    config.scanIntervalSeconds = parseNumber(settings.scan_interval_seconds, config.scanIntervalSeconds, 10);
  }
  if (settings.scan_jitter_seconds !== undefined) {
    config.scanJitterSeconds = parseNumber(settings.scan_jitter_seconds, config.scanJitterSeconds, 0);
  }
  if (settings.page_timeout_seconds !== undefined) {
    config.pageTimeoutMs = parseNumber(settings.page_timeout_seconds, config.pageTimeoutMs / 1000, 5) * 1000;
  }
  if (settings.product_ready_timeout_seconds !== undefined) {
    config.productReadyTimeoutMs =
      parseNumber(settings.product_ready_timeout_seconds, config.productReadyTimeoutMs / 1000, 1) * 1000;
  }
  if (settings.page_settle_seconds !== undefined) {
    config.pageSettleMs = parseNumber(settings.page_settle_seconds, config.pageSettleMs / 1000, 0) * 1000;
  }
  if (settings.section_delay_seconds !== undefined) {
    config.sectionDelayMs = parseNumber(settings.section_delay_seconds, config.sectionDelayMs / 1000, 0) * 1000;
  }
  if (settings.browser_restart_interval_minutes !== undefined) {
    config.browserRestartIntervalMs =
      parseNumber(settings.browser_restart_interval_minutes, config.browserRestartIntervalMs / 60000, 0) * 60 * 1000;
  }
  if (settings.browser_memory_recycle_mb !== undefined) {
    config.browserMemoryRecycleMb = parseNumber(
      settings.browser_memory_recycle_mb,
      config.browserMemoryRecycleMb,
      0
    );
  }
  if (settings.browser_memory_recycle_cooldown_minutes !== undefined) {
    config.browserMemoryRecycleCooldownMs =
      parseNumber(
        settings.browser_memory_recycle_cooldown_minutes,
        config.browserMemoryRecycleCooldownMs / 60000,
        1
      ) *
      60 *
      1000;
  }

  config.telegramControlLanguage = normalizeLanguage(
    settings.control_language,
    normalizeLanguage(baseConfig.telegramControlLanguage, "en")
  );

  return config;
}

module.exports = {
  applyRuntimeSettings,
  CONTROL_OFFSET_KEY,
  normalizeLanguage,
  USER_SETTING_KEYS
};
