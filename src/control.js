"use strict";

const { parseTimeWindow, isTimeWindowActive } = require("./time-window");
const { CONTROL_OFFSET_KEY, normalizeLanguage, USER_SETTING_KEYS } = require("./runtime-config");
const { sleep } = require("./utils");

const FAST_PROFILE_ON = {
  panic_mode: "true",
  panic_until_ms: "0",
  panic_scan_interval_seconds: "5",
  panic_scan_jitter_seconds: "0",
  scan_interval_seconds: "10",
  scan_jitter_seconds: "0",
  page_timeout_seconds: "18",
  product_ready_timeout_seconds: "2",
  page_settle_seconds: "0",
  section_delay_seconds: "0"
};

const FAST_PROFILE_OFF = {
  panic_mode: "false",
  panic_until_ms: "0",
  panic_scan_interval_seconds: "10",
  panic_scan_jitter_seconds: "3",
  scan_interval_seconds: "30",
  scan_jitter_seconds: "10",
  page_timeout_seconds: "45",
  product_ready_timeout_seconds: "5",
  page_settle_seconds: "1",
  section_delay_seconds: "1"
};

const RESET_ALIASES = {
  all: USER_SETTING_KEYS,
  language: ["control_language"],
  lang: ["control_language"],
  notify_all: ["notify_all_products"],
  notify_all_window: ["notify_all_products_window"],
  window: ["notify_all_products_window"],
  score: ["min_score_to_notify"],
  min_score: ["min_score_to_notify"],
  value: ["min_value_to_notify_eur"],
  min_value: ["min_value_to_notify_eur"],
  strict: ["strict_notify_mode"],
  strict_signals: ["strict_min_positive_signals", "strict_max_negative_signals"],
  max_notifications: ["max_notifications_per_cycle"],
  panic: ["panic_mode", "panic_until_ms"],
  panic_interval: ["panic_scan_interval_seconds", "panic_scan_jitter_seconds"],
  scan_interval: ["scan_interval_seconds", "scan_jitter_seconds"],
  fast: Object.keys(FAST_PROFILE_ON)
};

function normalizeCommandName(value) {
  return String(value || "").split("@")[0].trim().toLowerCase();
}

function parseCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  return {
    command: normalizeCommandName(parts[0]),
    args: parts.slice(1)
  };
}

function parseOnOff(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["on", "true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseNumberArg(value, { min = undefined, max = undefined, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (integer && !Number.isInteger(parsed)) {
    return null;
  }
  if (min !== undefined && parsed < min) {
    return null;
  }
  if (max !== undefined && parsed > max) {
    return null;
  }
  return parsed;
}

function setMany(storage, values) {
  for (const [key, value] of Object.entries(values)) {
    storage.setSetting(key, value);
  }
}

function boolText(value, language) {
  if (language === "it") {
    return value ? "attivo" : "spento";
  }
  return value ? "on" : "off";
}

function formatEuro(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `EUR ${parsed.toFixed(2)}` : "n/a";
}

function isPanicActive(config, nowMs = Date.now()) {
  return Boolean(config.panicMode || (config.panicUntilMs && nowMs < config.panicUntilMs));
}

function notifyAllActive(config, nowMs = Date.now()) {
  return Boolean(
    config.notifyAllProducts ||
      (config.notifyAllProductsWindow && isTimeWindowActive(config.notifyAllProductsWindow, config.timezoneId, nowMs))
  );
}

function seconds(valueMs) {
  return `${Math.round(Number(valueMs || 0) / 1000)}s`;
}

function helpMessage(language) {
  if (language === "it") {
    return [
      "Vine Watcher Control",
      "",
      "Comandi principali:",
      "/status - stato live, ultimo ciclo e modalita attive",
      "/config - configurazione efficace corrente",
      "/help - questo help",
      "/lang it|en - cambia lingua del bot",
      "",
      "Notifiche:",
      "/notify_all on|off - segnala tutto sempre",
      "/notify_all_window 09:00-22:30 - segnala tutto solo in fascia oraria",
      "/notify_all_window off - disattiva la fascia notify-all",
      "/min_score 5 - soglia score",
      "/min_value 35 - soglia valore stimato in euro",
      "/strict on|off - strict mode",
      "/strict_signals 2 0 - min positivi e max negativi",
      "/max_notifications 10 - limite notifiche per ciclo",
      "",
      "Velocita:",
      "/panic on|off - panic mode permanente on/off",
      "/panic 30 - panic mode per 30 minuti",
      "/panic_interval 5 0 - intervallo panic e jitter",
      "/scan_interval 30 10 - intervallo normale e jitter",
      "/fast on|off - profilo veloce o conservativo",
      "",
      "Manutenzione:",
      "/reset key - rimuove un override runtime",
      "/reset all - rimuove tutti gli override runtime",
      "",
      "Esempi:",
      "/notify_all_window 09:00-22:30",
      "/min_score 20",
      "/strict on",
      "/fast on"
    ].join("\n");
  }

  return [
    "Vine Watcher Control",
    "",
    "Core commands:",
    "/status - live status, last cycle, active modes",
    "/config - current effective configuration",
    "/help - this help",
    "/lang it|en - change bot language",
    "",
    "Notifications:",
    "/notify_all on|off - notify every product all the time",
    "/notify_all_window 09:00-22:30 - notify every product only during a daily window",
    "/notify_all_window off - disable the notify-all window",
    "/min_score 5 - score threshold",
    "/min_value 35 - estimated value threshold in euro",
    "/strict on|off - strict mode",
    "/strict_signals 2 0 - min positive and max negative signals",
    "/max_notifications 10 - notification limit per cycle",
    "",
    "Speed:",
    "/panic on|off - permanent panic mode on/off",
    "/panic 30 - panic mode for 30 minutes",
    "/panic_interval 5 0 - panic interval and jitter",
    "/scan_interval 30 10 - normal interval and jitter",
    "/fast on|off - fast or conservative profile",
    "",
    "Maintenance:",
    "/reset key - remove one runtime override",
    "/reset all - remove all runtime overrides",
    "",
    "Examples:",
    "/notify_all_window 09:00-22:30",
    "/min_score 20",
    "/strict on",
    "/fast on"
  ].join("\n");
}

class TelegramControl {
  constructor({ telegram, storage, getConfig, getStatus, logger }) {
    this.telegram = telegram;
    this.storage = storage;
    this.getConfig = getConfig;
    this.getStatus = getStatus || (() => ({}));
    this.logger = logger;
    this.running = false;
    this.offset = null;
    this.loopPromise = null;
  }

  language() {
    const config = this.getConfig();
    const settings = this.storage.getSettings();
    return normalizeLanguage(settings.control_language, config.telegramControlLanguage || "en");
  }

  async start() {
    const config = this.getConfig();
    if (!config.telegramControlEnabled) {
      return;
    }
    if (!this.telegram.enabled) {
      this.logger.warn("Telegram control is enabled but Telegram is not configured");
      return;
    }

    this.running = true;
    await this.initializeOffset();
    this.loopPromise = this.pollLoop().catch((error) => {
      this.logger.error(`Telegram control loop stopped: ${error.message}`);
    });
    this.logger.info("Telegram control enabled");
  }

  stop() {
    this.running = false;
  }

  async initializeOffset() {
    const stored = Number(this.storage.getSetting(CONTROL_OFFSET_KEY, ""));
    if (Number.isInteger(stored) && stored > 0) {
      this.offset = stored;
      return;
    }

    const updates = await this.telegram.getUpdates({ timeout: 0 });
    if (Array.isArray(updates) && updates.length > 0) {
      const maxUpdateId = Math.max(...updates.map((update) => update.update_id || 0));
      this.offset = maxUpdateId + 1;
      this.storage.setSetting(CONTROL_OFFSET_KEY, String(this.offset));
      this.logger.info(`Telegram control initialized at update offset ${this.offset}`);
    }
  }

  async pollLoop() {
    while (this.running) {
      const config = this.getConfig();
      try {
        const updates = await this.telegram.getUpdates({
          offset: this.offset,
          timeout: Math.max(1, Math.round(config.telegramControlPollSeconds || 3))
        });

        if (!this.running) {
          break;
        }

        if (Array.isArray(updates)) {
          for (const update of updates) {
            if (!this.running) {
              break;
            }
            this.offset = Number(update.update_id || 0) + 1;
            this.storage.setSetting(CONTROL_OFFSET_KEY, String(this.offset));
            await this.handleUpdate(update);
          }
        }
      } catch (error) {
        this.logger.warn(`Telegram control polling failed: ${error.message}`);
        await sleep(Math.max(1000, (config.telegramControlPollSeconds || 3) * 1000));
      }
    }
  }

  async handleUpdate(update) {
    const message = update && update.message;
    const text = message && message.text;
    if (!message || !text) {
      return;
    }

    const chatId = String(message.chat && message.chat.id ? message.chat.id : "");
    const allowedChatId = String(this.getConfig().telegramChatId || "");
    if (chatId !== allowedChatId) {
      this.logger.warn(`Ignoring Telegram control message from unauthorized chat ${chatId || "unknown"}`);
      return;
    }

    const response = await this.executeCommand(text);
    if (response) {
      await this.telegram.sendText(response);
    }
  }

  async executeCommand(text) {
    const parsed = parseCommand(text);
    const language = this.language();
    if (!parsed) {
      return null;
    }

    const { command, args } = parsed;

    if (command === "/start" || command === "/help" || command === "/aiuto") {
      return helpMessage(language);
    }
    if (command === "/lang" || command === "/language" || command === "/lingua") {
      return this.commandLanguage(args, language);
    }
    if (command === "/status" || command === "/stato") {
      return this.formatStatus(this.language());
    }
    if (command === "/config") {
      return this.formatConfig(this.language());
    }
    if (command === "/notify_all") {
      return this.commandNotifyAll(args, language);
    }
    if (command === "/notify_all_window") {
      return this.commandNotifyAllWindow(args, language);
    }
    if (command === "/min_score") {
      return this.commandNumber("min_score_to_notify", args, language, { min: 0, integer: true });
    }
    if (command === "/min_value") {
      return this.commandNumber("min_value_to_notify_eur", args, language, { min: 0 });
    }
    if (command === "/strict") {
      return this.commandBoolean("strict_notify_mode", args, language);
    }
    if (command === "/strict_signals") {
      return this.commandStrictSignals(args, language);
    }
    if (command === "/max_notifications") {
      return this.commandNumber("max_notifications_per_cycle", args, language, { min: 1, integer: true });
    }
    if (command === "/panic") {
      return this.commandPanic(args, language);
    }
    if (command === "/panic_interval") {
      return this.commandInterval("panic_scan_interval_seconds", "panic_scan_jitter_seconds", args, language, 5);
    }
    if (command === "/scan_interval") {
      return this.commandInterval("scan_interval_seconds", "scan_jitter_seconds", args, language, 10);
    }
    if (command === "/fast") {
      return this.commandFast(args, language);
    }
    if (command === "/reset") {
      return this.commandReset(args, language);
    }

    return language === "it"
      ? `Comando non riconosciuto: ${command}\nUsa /help.`
      : `Unknown command: ${command}\nUse /help.`;
  }

  commandLanguage(args, language) {
    const nextLanguage = normalizeLanguage(args[0], "");
    if (!nextLanguage) {
      return language === "it" ? "Uso: /lang it|en" : "Usage: /lang it|en";
    }
    this.storage.setSetting("control_language", nextLanguage);
    return nextLanguage === "it" ? "Lingua impostata: italiano." : "Language set: English.";
  }

  commandBoolean(key, args, language) {
    const value = parseOnOff(args[0]);
    if (value === null) {
      return language === "it" ? "Uso: on oppure off." : "Usage: on or off.";
    }
    this.storage.setSetting(key, value ? "true" : "false");
    return this.ok(language, `${key}=${value ? "true" : "false"}`);
  }

  commandNotifyAll(args, language) {
    return this.commandBoolean("notify_all_products", args, language);
  }

  commandNotifyAllWindow(args, language) {
    const value = String(args[0] || "").trim();
    if (!value) {
      return language === "it"
        ? "Uso: /notify_all_window 09:00-22:30 oppure /notify_all_window off"
        : "Usage: /notify_all_window 09:00-22:30 or /notify_all_window off";
    }
    if (value.toLowerCase() === "off") {
      this.storage.setSetting("notify_all_products_window", "");
      return this.ok(language, "notify_all_products_window=off");
    }
    const window = parseTimeWindow(value);
    if (!window) {
      return language === "it"
        ? "Formato non valido. Usa HH:MM-HH:MM, esempio 09:00-22:30."
        : "Invalid format. Use HH:MM-HH:MM, for example 09:00-22:30.";
    }
    this.storage.setSetting("notify_all_products_window", window.label);
    return this.ok(language, `notify_all_products_window=${window.label}`);
  }

  commandNumber(key, args, language, options = {}) {
    const value = parseNumberArg(args[0], options);
    if (value === null) {
      return language === "it" ? "Numero non valido." : "Invalid number.";
    }
    this.storage.setSetting(key, String(value));
    return this.ok(language, `${key}=${value}`);
  }

  commandStrictSignals(args, language) {
    const positive = parseNumberArg(args[0], { min: 0, integer: true });
    const negative = parseNumberArg(args[1] === undefined ? "0" : args[1], { min: 0, integer: true });
    if (positive === null || negative === null) {
      return language === "it"
        ? "Uso: /strict_signals 2 0"
        : "Usage: /strict_signals 2 0";
    }
    this.storage.setSetting("strict_min_positive_signals", String(positive));
    this.storage.setSetting("strict_max_negative_signals", String(negative));
    return this.ok(language, `strict_min_positive_signals=${positive}, strict_max_negative_signals=${negative}`);
  }

  commandPanic(args, language) {
    const value = String(args[0] || "").trim().toLowerCase();
    if (!value) {
      return language === "it" ? "Uso: /panic on|off|30" : "Usage: /panic on|off|30";
    }

    const enabled = parseOnOff(value);
    if (enabled !== null) {
      this.storage.setSetting("panic_mode", enabled ? "true" : "false");
      this.storage.setSetting("panic_until_ms", "0");
      return this.ok(language, `panic_mode=${enabled ? "true" : "false"}`);
    }

    const minutes = parseNumberArg(value, { min: 1, max: 1440, integer: true });
    if (minutes === null) {
      return language === "it" ? "Uso: /panic on|off|30" : "Usage: /panic on|off|30";
    }

    const until = Date.now() + minutes * 60 * 1000;
    this.storage.setSetting("panic_mode", "false");
    this.storage.setSetting("panic_until_ms", String(until));
    return this.ok(language, `panic_until=${new Date(until).toISOString()}`);
  }

  commandInterval(baseKey, jitterKey, args, language, minBase) {
    const base = parseNumberArg(args[0], { min: minBase, integer: true });
    const jitter = parseNumberArg(args[1] === undefined ? "0" : args[1], { min: 0, integer: true });
    if (base === null || jitter === null) {
      return language === "it"
        ? `Uso: /${baseKey.startsWith("panic") ? "panic_interval" : "scan_interval"} ${minBase} 0`
        : `Usage: /${baseKey.startsWith("panic") ? "panic_interval" : "scan_interval"} ${minBase} 0`;
    }
    this.storage.setSetting(baseKey, String(base));
    this.storage.setSetting(jitterKey, String(jitter));
    return this.ok(language, `${baseKey}=${base}, ${jitterKey}=${jitter}`);
  }

  commandFast(args, language) {
    const enabled = parseOnOff(args[0]);
    if (enabled === null) {
      return language === "it" ? "Uso: /fast on|off" : "Usage: /fast on|off";
    }
    setMany(this.storage, enabled ? FAST_PROFILE_ON : FAST_PROFILE_OFF);
    return this.ok(language, enabled ? "fast profile on" : "fast profile off");
  }

  commandReset(args, language) {
    const key = String(args[0] || "").trim().toLowerCase();
    const keys = RESET_ALIASES[key] || (USER_SETTING_KEYS.includes(key) ? [key] : null);
    if (!keys) {
      const allowed = [...new Set([...Object.keys(RESET_ALIASES), ...USER_SETTING_KEYS])].sort().join(", ");
      return language === "it" ? `Uso: /reset key|all\nKey: ${allowed}` : `Usage: /reset key|all\nKeys: ${allowed}`;
    }
    for (const settingKey of keys) {
      this.storage.deleteSetting(settingKey);
    }
    return this.ok(language, key === "all" ? "all runtime overrides reset" : `${key} reset`);
  }

  ok(language, detail) {
    return language === "it" ? `Fatto.\n${detail}` : `Done.\n${detail}`;
  }

  formatStatus(language) {
    const config = this.getConfig();
    const status = this.getStatus();
    const lastCycle = status.lastCycle;
    const lines =
      language === "it"
        ? [
            "Vine Watcher status",
            "",
            `Notify all: ${boolText(notifyAllActive(config), language)}`,
            `Notify all sempre: ${boolText(config.notifyAllProducts, language)}`,
            `Notify all finestra: ${config.notifyAllProductsWindow || "none"}`,
            `Score minimo: ${config.minScoreToNotify}`,
            `Valore minimo: ${formatEuro(config.minValueToNotifyEur)}`,
            `Strict: ${boolText(config.strictNotifyMode, language)} (${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-)`,
            `Panic: ${boolText(isPanicActive(config), language)}`,
            `Intervallo panic: ${config.panicScanIntervalSeconds}s + ${config.panicScanJitterSeconds}s jitter`,
            `Limite notifiche/ciclo: ${config.maxNotificationsPerCycle}`
          ]
        : [
            "Vine Watcher status",
            "",
            `Notify all: ${boolText(notifyAllActive(config), language)}`,
            `Notify all always: ${boolText(config.notifyAllProducts, language)}`,
            `Notify all window: ${config.notifyAllProductsWindow || "none"}`,
            `Min score: ${config.minScoreToNotify}`,
            `Min value: ${formatEuro(config.minValueToNotifyEur)}`,
            `Strict: ${boolText(config.strictNotifyMode, language)} (${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-)`,
            `Panic: ${boolText(isPanicActive(config), language)}`,
            `Panic interval: ${config.panicScanIntervalSeconds}s + ${config.panicScanJitterSeconds}s jitter`,
            `Notification limit/cycle: ${config.maxNotificationsPerCycle}`
          ];

    if (lastCycle) {
      lines.push(
        "",
        language === "it" ? "Ultimo ciclo:" : "Last cycle:",
        `scanned=${lastCycle.scanned} new=${lastCycle.newProducts} notified=${lastCycle.notified} max_score=${lastCycle.maxScore}`,
        `elapsed=${lastCycle.elapsedSeconds}s`
      );
    }

    return lines.join("\n");
  }

  formatConfig(language) {
    const config = this.getConfig();
    const settings = this.storage.getSettings();
    const runtimeKeys = USER_SETTING_KEYS.filter((key) => settings[key] !== undefined);
    const lines =
      language === "it"
        ? [
            "Configurazione efficace",
            "",
            `Lingua: ${config.telegramControlLanguage}`,
            `Notify all: ${boolText(config.notifyAllProducts, language)}`,
            `Notify all window: ${config.notifyAllProductsWindow || "none"}`,
            `Min score: ${config.minScoreToNotify}`,
            `Min value: ${formatEuro(config.minValueToNotifyEur)}`,
            `Strict: ${boolText(config.strictNotifyMode, language)}`,
            `Strict signals: ${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-`,
            `Max notifications: ${config.maxNotificationsPerCycle}`,
            `Panic mode: ${boolText(config.panicMode, language)}`,
            `Panic until: ${config.panicUntilMs ? new Date(config.panicUntilMs).toISOString() : "none"}`,
            `Panic interval: ${config.panicScanIntervalSeconds}s jitter=${config.panicScanJitterSeconds}s`,
            `Scan interval: ${config.scanIntervalSeconds}s jitter=${config.scanJitterSeconds}s`,
            `Page timeout: ${seconds(config.pageTimeoutMs)}`,
            `Product ready timeout: ${seconds(config.productReadyTimeoutMs)}`,
            `Page settle: ${seconds(config.pageSettleMs)}`,
            `Section delay: ${seconds(config.sectionDelayMs)}`,
            "",
            `Override runtime: ${runtimeKeys.length > 0 ? runtimeKeys.join(", ") : "none"}`
          ]
        : [
            "Effective configuration",
            "",
            `Language: ${config.telegramControlLanguage}`,
            `Notify all: ${boolText(config.notifyAllProducts, language)}`,
            `Notify all window: ${config.notifyAllProductsWindow || "none"}`,
            `Min score: ${config.minScoreToNotify}`,
            `Min value: ${formatEuro(config.minValueToNotifyEur)}`,
            `Strict: ${boolText(config.strictNotifyMode, language)}`,
            `Strict signals: ${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-`,
            `Max notifications: ${config.maxNotificationsPerCycle}`,
            `Panic mode: ${boolText(config.panicMode, language)}`,
            `Panic until: ${config.panicUntilMs ? new Date(config.panicUntilMs).toISOString() : "none"}`,
            `Panic interval: ${config.panicScanIntervalSeconds}s jitter=${config.panicScanJitterSeconds}s`,
            `Scan interval: ${config.scanIntervalSeconds}s jitter=${config.scanJitterSeconds}s`,
            `Page timeout: ${seconds(config.pageTimeoutMs)}`,
            `Product ready timeout: ${seconds(config.productReadyTimeoutMs)}`,
            `Page settle: ${seconds(config.pageSettleMs)}`,
            `Section delay: ${seconds(config.sectionDelayMs)}`,
            "",
            `Runtime overrides: ${runtimeKeys.length > 0 ? runtimeKeys.join(", ") : "none"}`
          ];
    return lines.join("\n");
  }
}

module.exports = {
  helpMessage,
  parseCommand,
  TelegramControl
};
