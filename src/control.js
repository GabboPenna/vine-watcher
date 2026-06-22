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

const CALLBACK_COMMANDS = {
  "vw:fast:on": "/fast on",
  "vw:fast:off": "/fast off",
  "vw:notify_all:on": "/notify_all on",
  "vw:notify_all:off": "/notify_all off",
  "vw:panic:30": "/panic 30",
  "vw:panic:off": "/panic off",
  "vw:score:5": "/min_score 5",
  "vw:value:35": "/min_value 35",
  "vw:strict:on": "/strict on",
  "vw:strict:off": "/strict off",
  "vw:lang:it": "/lang it",
  "vw:lang:en": "/lang en"
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
    return value ? "✅ attivo" : "⏸️ spento";
  }
  return value ? "✅ on" : "⏸️ off";
}

function formatEuro(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `€${parsed.toFixed(2)}` : "n/a";
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

function isTelegramMessageNotModified(error) {
  const message = String(error && error.message ? error.message : error).toLowerCase();
  return message.includes("message is not modified") || message.includes("message not modified");
}

function formatWindow(value, language) {
  return value || (language === "it" ? "nessuna" : "none");
}

function formatLastCycle(lastCycle, language) {
  if (!lastCycle) {
    return language === "it"
      ? ["🕒 Ultimo ciclo: non ancora disponibile"]
      : ["🕒 Last cycle: not available yet"];
  }

  return language === "it"
    ? [
        "🕒 Ultimo giro:",
        `• visti: ${lastCycle.scanned}`,
        `• nuovi: ${lastCycle.newProducts}`,
        `• notificati: ${lastCycle.notified}`,
        `• score massimo: ${lastCycle.maxScore}`,
        `• durata: ${lastCycle.elapsedSeconds}s`
      ]
    : [
        "🕒 Last sweep:",
        `• scanned: ${lastCycle.scanned}`,
        `• new: ${lastCycle.newProducts}`,
        `• notified: ${lastCycle.notified}`,
        `• max score: ${lastCycle.maxScore}`,
        `• duration: ${lastCycle.elapsedSeconds}s`
      ];
}

function controlCommands(language) {
  if (language === "it") {
    return [
      { command: "menu", description: "Apri il pannello con pulsanti" },
      { command: "status", description: "Stato live e ultimo ciclo" },
      { command: "config", description: "Configurazione efficace corrente" },
      { command: "help", description: "Guida completa dei comandi" },
      { command: "fast", description: "Profilo veloce o conservativo" },
      { command: "panic", description: "Panic mode on, off o temporaneo" },
      { command: "notify_all", description: "Segnala ogni prodotto on/off" },
      { command: "notify_all_window", description: "Fascia oraria notify-all" },
      { command: "min_score", description: "Imposta soglia score" },
      { command: "min_value", description: "Imposta soglia valore stimato" },
      { command: "strict", description: "Strict mode on/off" },
      { command: "lang", description: "Lingua bot it/en" }
    ];
  }

  return [
    { command: "menu", description: "Open the button control panel" },
    { command: "status", description: "Live status and last cycle" },
    { command: "config", description: "Current effective configuration" },
    { command: "help", description: "Full command guide" },
    { command: "fast", description: "Fast or conservative profile" },
    { command: "panic", description: "Panic mode on, off, or temporary" },
    { command: "notify_all", description: "Notify every product on/off" },
    { command: "notify_all_window", description: "Notify-all time window" },
    { command: "min_score", description: "Set score threshold" },
    { command: "min_value", description: "Set estimated value threshold" },
    { command: "strict", description: "Strict mode on/off" },
    { command: "lang", description: "Bot language it/en" }
  ];
}

function helpMessage(language) {
  if (language === "it") {
    return [
      "✨ Vine Watcher Control",
      "Ti ascolto da qui: puoi chiedermi lo stato, cambiare soglie e aprire il pannello rapido.",
      "",
      "📌 Comandi principali:",
      "/menu - apre il pannello con pulsanti rapidi",
      "/status - ti dico come sto lavorando ora",
      "/config - mostra la configurazione efficace",
      "/help - mostra questa guida",
      "/lang it|en - cambia lingua",
      "",
      "🔔 Notifiche:",
      "/notify_all on|off - segnala tutto sempre",
      "/notify_all_window 09:00-22:30 - segnala tutto solo in fascia oraria",
      "/notify_all_window off - disattiva la fascia notify-all",
      "/min_score 5 - soglia score",
      "/min_value 35 - soglia valore stimato in euro",
      "/strict on|off - strict mode",
      "/strict_signals 2 0 - min positivi e max negativi",
      "/max_notifications 10 - limite notifiche per ciclo",
      "",
      "⚡ Velocita:",
      "/panic on|off - panic mode permanente on/off",
      "/panic 30 - panic mode per 30 minuti",
      "/panic_interval 5 0 - intervallo panic e jitter",
      "/scan_interval 30 10 - intervallo normale e jitter",
      "/fast on|off - profilo veloce o conservativo",
      "",
      "🧹 Manutenzione:",
      "/reset key - rimuove un override runtime",
      "/reset all - rimuove tutti gli override runtime",
      "",
      "💡 Esempi:",
      "/notify_all_window 09:00-22:30",
      "/min_score 20",
      "/strict on",
      "/fast on"
    ].join("\n");
  }

  return [
    "✨ Vine Watcher Control",
    "I am listening here: ask for status, tune thresholds, or open the quick panel.",
    "",
    "📌 Core commands:",
    "/menu - open the button control panel",
    "/status - show how I am working right now",
    "/config - show the effective configuration",
    "/help - show this guide",
    "/lang it|en - change language",
    "",
    "🔔 Notifications:",
    "/notify_all on|off - notify every product all the time",
    "/notify_all_window 09:00-22:30 - notify every product only during a daily window",
    "/notify_all_window off - disable the notify-all window",
    "/min_score 5 - score threshold",
    "/min_value 35 - estimated value threshold in euro",
    "/strict on|off - strict mode",
    "/strict_signals 2 0 - min positive and max negative signals",
    "/max_notifications 10 - notification limit per cycle",
    "",
    "⚡ Speed:",
    "/panic on|off - permanent panic mode on/off",
    "/panic 30 - panic mode for 30 minutes",
    "/panic_interval 5 0 - panic interval and jitter",
    "/scan_interval 30 10 - normal interval and jitter",
    "/fast on|off - fast or conservative profile",
    "",
    "🧹 Maintenance:",
    "/reset key - remove one runtime override",
    "/reset all - remove all runtime overrides",
    "",
    "💡 Examples:",
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
    await this.registerCommands().catch((error) => {
      this.logger.warn(`Telegram command menu registration failed: ${error.message}`);
    });
    await this.initializeOffset();
    this.loopPromise = this.pollLoop().catch((error) => {
      this.logger.error(`Telegram control loop stopped: ${error.message}`);
    });
    this.logger.info("Telegram control enabled");
  }

  stop() {
    this.running = false;
  }

  async registerCommands(language = this.language()) {
    await this.telegram.setCommands(controlCommands(language));
    await this.telegram.setChatMenuButton();
    this.logger.info(`Telegram command menu registered in ${language}`);
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
    if (update && update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

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
    await this.sendResponse(response);
  }

  async handleCallbackQuery(callbackQuery) {
    const message = callbackQuery && callbackQuery.message;
    const chatId = String(message && message.chat && message.chat.id ? message.chat.id : "");
    const messageId = message && message.message_id;
    const allowedChatId = String(this.getConfig().telegramChatId || "");

    if (chatId !== allowedChatId) {
      this.logger.warn(`Ignoring Telegram control callback from unauthorized chat ${chatId || "unknown"}`);
      if (callbackQuery.id) {
        await this.telegram.answerCallbackQuery(callbackQuery.id, "Unauthorized").catch(() => {});
      }
      return;
    }

    const data = String(callbackQuery.data || "");
    const language = this.language();
    let text = "";
    let options = {};
    let toast = language === "it" ? "✅ Fatto" : "✅ Done";

    if (data === "vw:menu") {
      ({ text, options } = this.menuResponse(language));
    } else if (data === "vw:status") {
      text = this.formatStatus(language);
      options = {
        reply_markup: this.backKeyboard(language)
      };
    } else if (data === "vw:config") {
      text = this.formatConfig(language);
      options = {
        reply_markup: this.backKeyboard(language)
      };
    } else if (data === "vw:help") {
      text = helpMessage(language);
      options = {
        reply_markup: this.backKeyboard(language)
      };
    } else if (CALLBACK_COMMANDS[data]) {
      const result = await this.executeCommand(CALLBACK_COMMANDS[data], {
        fromCallback: true
      });
      const nextLanguage = this.language();
      const response = this.menuResponse(nextLanguage, typeof result === "string" ? result : "");
      text = response.text;
      options = response.options;
      toast = nextLanguage === "it" ? "✅ Aggiornato" : "✅ Updated";
    } else {
      text = language === "it"
        ? "🤔 Questa azione non la riconosco ancora. Torna al menu e riproviamo."
        : "🤔 I do not recognize this action yet. Go back to the menu and try again.";
      options = {
        reply_markup: this.backKeyboard(language)
      };
      toast = language === "it" ? "Azione non valida" : "Invalid action";
    }

    if (callbackQuery.id) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, toast).catch((error) => {
        this.logger.warn(`Telegram callback answer failed: ${error.message}`);
      });
    }

    await this.editOrSend(chatId, messageId, text, options);
  }

  async sendResponse(response) {
    if (!response) {
      return;
    }
    if (typeof response === "string") {
      await this.telegram.sendText(response);
      return;
    }
    await this.telegram.sendText(response.text, response.options || {});
  }

  async editOrSend(chatId, messageId, text, options = {}) {
    if (chatId && messageId) {
      try {
        await this.telegram.editText(chatId, messageId, text, options);
        return;
      } catch (error) {
        if (isTelegramMessageNotModified(error)) {
          if (this.logger.debug) {
            this.logger.debug("Telegram menu edit skipped because message is unchanged");
          }
          return;
        }
        this.logger.warn(`Telegram menu edit failed, sending a new message: ${error.message}`);
      }
    }

    await this.telegram.sendText(text, {
      ...options,
      chat_id: chatId || undefined
    });
  }

  async executeCommand(text, options = {}) {
    const parsed = parseCommand(text);
    const language = this.language();
    if (!parsed) {
      return null;
    }

    const { command, args } = parsed;

    if (command === "/start" || command === "/menu") {
      return this.menuResponse(language);
    }
    if (command === "/help" || command === "/aiuto") {
      return helpMessage(language);
    }
    if (command === "/lang" || command === "/language" || command === "/lingua") {
      return this.commandLanguage(args, language, options);
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
      ? `🤔 Non conosco ancora questo comando: ${command}\nProva /menu oppure /help.`
      : `🤔 I do not know this command yet: ${command}\nTry /menu or /help.`;
  }

  menuResponse(language, actionResult = "") {
    return {
      text: this.formatMenu(language, actionResult),
      options: {
        reply_markup: this.menuKeyboard(language)
      }
    };
  }

  menuKeyboard(language) {
    const labels =
      language === "it"
        ? {
            status: "📊 Status",
            config: "⚙️ Config",
            refresh: "🔄 Aggiorna",
            fastOn: "⚡ Fast ON",
            fastOff: "🧘 Fast OFF",
            notifyOn: "🔔 Tutto ON",
            notifyOff: "🔕 Tutto OFF",
            panic30: "🚀 Panic 30m",
            panicOff: "🛬 Panic OFF",
            score5: "🎯 Score 5",
            value35: "💶 Valore 35",
            strictOn: "🧪 Strict ON",
            strictOff: "🌤️ Strict OFF",
            italian: "🇮🇹 Italiano",
            english: "🇬🇧 English",
            help: "❔ Help"
          }
        : {
            status: "📊 Status",
            config: "⚙️ Config",
            refresh: "🔄 Refresh",
            fastOn: "⚡ Fast ON",
            fastOff: "🧘 Fast OFF",
            notifyOn: "🔔 All ON",
            notifyOff: "🔕 All OFF",
            panic30: "🚀 Panic 30m",
            panicOff: "🛬 Panic OFF",
            score5: "🎯 Score 5",
            value35: "💶 Value 35",
            strictOn: "🧪 Strict ON",
            strictOff: "🌤️ Strict OFF",
            italian: "🇮🇹 Italiano",
            english: "🇬🇧 English",
            help: "❔ Help"
          };

    return {
      inline_keyboard: [
        [
          { text: labels.status, callback_data: "vw:status" },
          { text: labels.config, callback_data: "vw:config" },
          { text: labels.refresh, callback_data: "vw:menu" }
        ],
        [
          { text: labels.fastOn, callback_data: "vw:fast:on" },
          { text: labels.fastOff, callback_data: "vw:fast:off" }
        ],
        [
          { text: labels.notifyOn, callback_data: "vw:notify_all:on" },
          { text: labels.notifyOff, callback_data: "vw:notify_all:off" }
        ],
        [
          { text: labels.panic30, callback_data: "vw:panic:30" },
          { text: labels.panicOff, callback_data: "vw:panic:off" }
        ],
        [
          { text: labels.score5, callback_data: "vw:score:5" },
          { text: labels.value35, callback_data: "vw:value:35" }
        ],
        [
          { text: labels.strictOn, callback_data: "vw:strict:on" },
          { text: labels.strictOff, callback_data: "vw:strict:off" }
        ],
        [
          { text: labels.italian, callback_data: "vw:lang:it" },
          { text: labels.english, callback_data: "vw:lang:en" },
          { text: labels.help, callback_data: "vw:help" }
        ]
      ]
    };
  }

  backKeyboard(language) {
    return {
      inline_keyboard: [
        [
          {
            text: language === "it" ? "⬅️ Torna al menu" : "⬅️ Back to menu",
            callback_data: "vw:menu"
          }
        ]
      ]
    };
  }

  async commandLanguage(args, language) {
    const nextLanguage = normalizeLanguage(args[0], "");
    if (!nextLanguage) {
      return language === "it" ? "🗣️ Dimmi la lingua: /lang it oppure /lang en" : "🗣️ Tell me the language: /lang it or /lang en";
    }
    this.storage.setSetting("control_language", nextLanguage);
    await this.registerCommands(nextLanguage).catch((error) => {
      this.logger.warn(`Telegram command menu update failed: ${error.message}`);
    });
    return nextLanguage === "it" ? "✅ Lingua impostata: italiano." : "✅ Language set: English.";
  }

  commandBoolean(key, args, language) {
    const value = parseOnOff(args[0]);
    if (value === null) {
      return language === "it" ? "🙂 Mi serve on oppure off." : "🙂 I need on or off.";
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
        ? "🕘 Scrivimi una fascia tipo /notify_all_window 09:00-22:30, oppure off."
        : "🕘 Send a window like /notify_all_window 09:00-22:30, or off.";
    }
    if (value.toLowerCase() === "off") {
      this.storage.setSetting("notify_all_products_window", "");
      return this.ok(language, "notify_all_products_window=off");
    }
    const window = parseTimeWindow(value);
    if (!window) {
      return language === "it"
        ? "🕘 Formato non valido. Usa HH:MM-HH:MM, per esempio 09:00-22:30."
        : "🕘 Invalid format. Use HH:MM-HH:MM, for example 09:00-22:30.";
    }
    this.storage.setSetting("notify_all_products_window", window.label);
    return this.ok(language, `notify_all_products_window=${window.label}`);
  }

  commandNumber(key, args, language, options = {}) {
    const value = parseNumberArg(args[0], options);
    if (value === null) {
      return language === "it" ? "🔢 Questo numero non mi torna. Riprova con un valore valido." : "🔢 That number does not look right. Try a valid value.";
    }
    this.storage.setSetting(key, String(value));
    return this.ok(language, `${key}=${value}`);
  }

  commandStrictSignals(args, language) {
    const positive = parseNumberArg(args[0], { min: 0, integer: true });
    const negative = parseNumberArg(args[1] === undefined ? "0" : args[1], { min: 0, integer: true });
    if (positive === null || negative === null) {
      return language === "it"
        ? "🧪 Uso: /strict_signals 2 0"
        : "🧪 Usage: /strict_signals 2 0";
    }
    this.storage.setSetting("strict_min_positive_signals", String(positive));
    this.storage.setSetting("strict_max_negative_signals", String(negative));
    return this.ok(language, `strict_min_positive_signals=${positive}, strict_max_negative_signals=${negative}`);
  }

  commandPanic(args, language) {
    const value = String(args[0] || "").trim().toLowerCase();
    if (!value) {
      return language === "it" ? "🚀 Uso: /panic on, /panic off oppure /panic 30" : "🚀 Usage: /panic on, /panic off, or /panic 30";
    }

    const enabled = parseOnOff(value);
    if (enabled !== null) {
      this.storage.setSetting("panic_mode", enabled ? "true" : "false");
      this.storage.setSetting("panic_until_ms", "0");
      return this.ok(language, `panic_mode=${enabled ? "true" : "false"}`);
    }

    const minutes = parseNumberArg(value, { min: 1, max: 1440, integer: true });
    if (minutes === null) {
      return language === "it" ? "🚀 Uso: /panic on, /panic off oppure /panic 30" : "🚀 Usage: /panic on, /panic off, or /panic 30";
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
        ? `⏱️ Uso: /${baseKey.startsWith("panic") ? "panic_interval" : "scan_interval"} ${minBase} 0`
        : `⏱️ Usage: /${baseKey.startsWith("panic") ? "panic_interval" : "scan_interval"} ${minBase} 0`;
    }
    this.storage.setSetting(baseKey, String(base));
    this.storage.setSetting(jitterKey, String(jitter));
    return this.ok(language, `${baseKey}=${base}, ${jitterKey}=${jitter}`);
  }

  commandFast(args, language) {
    const enabled = parseOnOff(args[0]);
    if (enabled === null) {
      return language === "it" ? "⚡ Uso: /fast on oppure /fast off" : "⚡ Usage: /fast on or /fast off";
    }
    setMany(this.storage, enabled ? FAST_PROFILE_ON : FAST_PROFILE_OFF);
    return this.ok(language, enabled ? "fast profile on" : "fast profile off");
  }

  commandReset(args, language) {
    const key = String(args[0] || "").trim().toLowerCase();
    const keys = RESET_ALIASES[key] || (USER_SETTING_KEYS.includes(key) ? [key] : null);
    if (!keys) {
      const allowed = [...new Set([...Object.keys(RESET_ALIASES), ...USER_SETTING_KEYS])].sort().join(", ");
      return language === "it" ? `🧹 Dimmi cosa ripulire: /reset key oppure /reset all\nKey: ${allowed}` : `🧹 Tell me what to clean up: /reset key or /reset all\nKeys: ${allowed}`;
    }
    for (const settingKey of keys) {
      this.storage.deleteSetting(settingKey);
    }
    return this.ok(language, key === "all" ? "all runtime overrides reset" : `${key} reset`);
  }

  ok(language, detail) {
    return language === "it" ? `✅ Fatto, ho aggiornato questo:\n${detail}` : `✅ Done, I updated this:\n${detail}`;
  }

  formatMenu(language, actionResult = "") {
    const config = this.getConfig();
    const status = this.getStatus();
    const lastCycle = status.lastCycle;
    const lines =
      language === "it"
        ? [
            "🚀 Vine Watcher Control Panel",
            "Sto tenendo d'occhio Vine. Ecco come sono messo adesso:",
            "",
            `🔔 Notify all ora: ${boolText(notifyAllActive(config), language)}`,
            `🌍 Notify all 24/7: ${boolText(config.notifyAllProducts, language)}`,
            `🕘 Finestra notify-all: ${formatWindow(config.notifyAllProductsWindow, language)}`,
            `🎯 Score minimo: ${config.minScoreToNotify}`,
            `💶 Valore minimo: ${formatEuro(config.minValueToNotifyEur)}`,
            `🧪 Strict mode: ${boolText(config.strictNotifyMode, language)} ` +
              `(${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-)`,
            `⚡ Panic mode: ${boolText(isPanicActive(config), language)} ` +
              `(${config.panicScanIntervalSeconds}s + ${config.panicScanJitterSeconds}s jitter)`
          ]
        : [
            "🚀 Vine Watcher Control Panel",
            "I am watching Vine. Here is the current setup:",
            "",
            `🔔 Notify all now: ${boolText(notifyAllActive(config), language)}`,
            `🌍 Notify all 24/7: ${boolText(config.notifyAllProducts, language)}`,
            `🕘 Notify-all window: ${formatWindow(config.notifyAllProductsWindow, language)}`,
            `🎯 Min score: ${config.minScoreToNotify}`,
            `💶 Min value: ${formatEuro(config.minValueToNotifyEur)}`,
            `🧪 Strict mode: ${boolText(config.strictNotifyMode, language)} ` +
              `(${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-)`,
            `⚡ Panic mode: ${boolText(isPanicActive(config), language)} ` +
              `(${config.panicScanIntervalSeconds}s + ${config.panicScanJitterSeconds}s jitter)`
          ];

    if (lastCycle) {
      lines.push("", ...formatLastCycle(lastCycle, language));
    }

    if (actionResult) {
      lines.push("", language === "it" ? "✅ Ultima azione:" : "✅ Last action:", actionResult);
    }

    lines.push("", language === "it" ? "👇 Scegli un'azione:" : "👇 Choose an action:");
    return lines.join("\n");
  }

  formatStatus(language) {
    const config = this.getConfig();
    const status = this.getStatus();
    const lastCycle = status.lastCycle;
    const lines =
      language === "it"
        ? [
            "📊 Vine Watcher status",
            "Sono operativo. Questa è la foto del momento:",
            "",
            `🔔 Notify all ora: ${boolText(notifyAllActive(config), language)}`,
            `🌍 Notify all 24/7: ${boolText(config.notifyAllProducts, language)}`,
            `🕘 Finestra notify-all: ${formatWindow(config.notifyAllProductsWindow, language)}`,
            `🎯 Score minimo: ${config.minScoreToNotify}`,
            `💶 Valore minimo: ${formatEuro(config.minValueToNotifyEur)}`,
            `🧪 Strict mode: ${boolText(config.strictNotifyMode, language)} ` +
              `(${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-)`,
            `⚡ Panic mode: ${boolText(isPanicActive(config), language)}`,
            `⏱️ Intervallo panic: ${config.panicScanIntervalSeconds}s + ${config.panicScanJitterSeconds}s jitter`,
            `📣 Limite notifiche per giro: ${config.maxNotificationsPerCycle}`
          ]
        : [
            "📊 Vine Watcher status",
            "I am running. Here is the current snapshot:",
            "",
            `🔔 Notify all now: ${boolText(notifyAllActive(config), language)}`,
            `🌍 Notify all 24/7: ${boolText(config.notifyAllProducts, language)}`,
            `🕘 Notify-all window: ${formatWindow(config.notifyAllProductsWindow, language)}`,
            `🎯 Min score: ${config.minScoreToNotify}`,
            `💶 Min value: ${formatEuro(config.minValueToNotifyEur)}`,
            `🧪 Strict mode: ${boolText(config.strictNotifyMode, language)} ` +
              `(${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-)`,
            `⚡ Panic mode: ${boolText(isPanicActive(config), language)}`,
            `⏱️ Panic interval: ${config.panicScanIntervalSeconds}s + ${config.panicScanJitterSeconds}s jitter`,
            `📣 Notification limit per sweep: ${config.maxNotificationsPerCycle}`
          ];

    lines.push("", ...formatLastCycle(lastCycle, language));

    return lines.join("\n");
  }

  formatConfig(language) {
    const config = this.getConfig();
    const settings = this.storage.getSettings();
    const runtimeKeys = USER_SETTING_KEYS.filter((key) => settings[key] !== undefined);
    const lines =
      language === "it"
        ? [
            "⚙️ Configurazione efficace",
            "Questi sono i valori che sto usando adesso, inclusi eventuali override runtime.",
            "",
            `🗣️ Lingua: ${config.telegramControlLanguage}`,
            `🔔 Notify all ora: ${boolText(notifyAllActive(config), language)}`,
            `🌍 Notify all 24/7: ${boolText(config.notifyAllProducts, language)}`,
            `🕘 Finestra notify-all: ${formatWindow(config.notifyAllProductsWindow, language)}`,
            `🎯 Min score: ${config.minScoreToNotify}`,
            `💶 Min value: ${formatEuro(config.minValueToNotifyEur)}`,
            `🧪 Strict: ${boolText(config.strictNotifyMode, language)}`,
            `🧪 Strict signals: ${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-`,
            `📣 Max notifiche: ${config.maxNotificationsPerCycle}`,
            `⚡ Panic mode 24/7: ${boolText(config.panicMode, language)}`,
            `🚀 Panic fino a: ${config.panicUntilMs ? new Date(config.panicUntilMs).toISOString() : "nessuno"}`,
            `⏱️ Panic interval: ${config.panicScanIntervalSeconds}s jitter=${config.panicScanJitterSeconds}s`,
            `🔁 Scan interval: ${config.scanIntervalSeconds}s jitter=${config.scanJitterSeconds}s`,
            `🌐 Page timeout: ${seconds(config.pageTimeoutMs)}`,
            `📦 Product ready timeout: ${seconds(config.productReadyTimeoutMs)}`,
            `🧘 Page settle: ${seconds(config.pageSettleMs)}`,
            `🧭 Section delay: ${seconds(config.sectionDelayMs)}`,
            "",
            `📝 Override runtime: ${runtimeKeys.length > 0 ? runtimeKeys.join(", ") : "nessuno"}`
          ]
        : [
            "⚙️ Effective configuration",
            "These are the values I am using right now, including runtime overrides.",
            "",
            `🗣️ Language: ${config.telegramControlLanguage}`,
            `🔔 Notify all now: ${boolText(notifyAllActive(config), language)}`,
            `🌍 Notify all 24/7: ${boolText(config.notifyAllProducts, language)}`,
            `🕘 Notify-all window: ${formatWindow(config.notifyAllProductsWindow, language)}`,
            `🎯 Min score: ${config.minScoreToNotify}`,
            `💶 Min value: ${formatEuro(config.minValueToNotifyEur)}`,
            `🧪 Strict: ${boolText(config.strictNotifyMode, language)}`,
            `🧪 Strict signals: ${config.strictMinPositiveSignals}+ / ${config.strictMaxNegativeSignals}-`,
            `📣 Max notifications: ${config.maxNotificationsPerCycle}`,
            `⚡ Panic mode 24/7: ${boolText(config.panicMode, language)}`,
            `🚀 Panic until: ${config.panicUntilMs ? new Date(config.panicUntilMs).toISOString() : "none"}`,
            `⏱️ Panic interval: ${config.panicScanIntervalSeconds}s jitter=${config.panicScanJitterSeconds}s`,
            `🔁 Scan interval: ${config.scanIntervalSeconds}s jitter=${config.scanJitterSeconds}s`,
            `🌐 Page timeout: ${seconds(config.pageTimeoutMs)}`,
            `📦 Product ready timeout: ${seconds(config.productReadyTimeoutMs)}`,
            `🧘 Page settle: ${seconds(config.pageSettleMs)}`,
            `🧭 Section delay: ${seconds(config.sectionDelayMs)}`,
            "",
            `📝 Runtime overrides: ${runtimeKeys.length > 0 ? runtimeKeys.join(", ") : "none"}`
          ];
    return lines.join("\n");
  }
}

module.exports = {
  helpMessage,
  parseCommand,
  TelegramControl
};
