"use strict";

const path = require("path");
const dotenv = require("dotenv");
const { safeJsonParse } = require("./utils");

dotenv.config({ quiet: true });

const projectRoot = path.resolve(__dirname, "..");

const keywordConfig = {
  positiveKeywordsHigh: [
    "robot",
    "aspirapolvere",
    "monitor",
    "ssd",
    "nas",
    "zigbee",
    "matter",
    "home assistant",
    "telecamera",
    "videosorveglianza",
    "allarme",
    "deumidificatore",
    "purificatore",
    "macchina caffe",
    "trapano",
    "utensile",
    "power station",
    "docking station",
    "mini pc",
    "caricatore gan",
    "switch",
    "router",
    "access point",
    "stampante",
    "compressore",
    "lavapavimenti"
  ],
  positiveKeywordsNormal: [
    "wifi",
    "smart",
    "bluetooth",
    "usb-c",
    "elettrico",
    "professionale",
    "cucina",
    "giardino",
    "sicurezza",
    "sensore",
    "hub",
    "tastiera",
    "mouse",
    "cuffie",
    "microfono",
    "led",
    "batteria",
    "ricaricabile",
    "telecomando",
    "app",
    "tuya",
    "gpl",
    "metano"
  ],
  negativeKeywords: [
    "cover",
    "custodia",
    "pellicola",
    "adesivo",
    "palloncini",
    "decorazione",
    "unghie",
    "ciglia",
    "parrucca",
    "costume",
    "ricambio",
    "compatibile con",
    "integratore",
    "collana",
    "bracciale",
    "orecchini",
    "fermacapelli",
    "stampo",
    "toppa",
    "cerniera",
    "lacci",
    "bigiotteria"
  ],
  knownBrandsBonus: [
    "anker",
    "ugreen",
    "baseus",
    "tp-link",
    "reolink",
    "ezviz",
    "switchbot",
    "aqara",
    "sonoff",
    "bosch",
    "makita",
    "black+decker",
    "philips",
    "xiaomi",
    "dreame",
    "cecotec",
    "de'longhi",
    "chicco",
    "imou",
    "netgear",
    "logitech",
    "trust",
    "samsung",
    "sandisk",
    "crucial",
    "kingston"
  ],
  smartHomeKeywords: ["zigbee", "matter", "tuya", "wifi", "wi-fi", "sensore", "smart", "home assistant", "thread"],
  electronicsOrToolKeywords: [
    "elettronica",
    "alimentatore",
    "caricatore",
    "gan",
    "usb-c",
    "router",
    "switch",
    "ssd",
    "monitor",
    "nas",
    "mini pc",
    "trapano",
    "utensile",
    "compressore",
    "saldatore",
    "multimetro",
    "telecamera",
    "stampante"
  ],
  genericAccessoryKeywords: ["cover", "custodia", "pellicola", "cavo", "supporto", "protezione", "adesivo", "stampo"],
  nicheReplacementKeywords: [
    "ricambio",
    "compatibile con",
    "per modello",
    "solo per",
    "filtro per",
    "lama per",
    "batteria per",
    "refill",
    "cartuccia"
  ]
};

function readEnv(name, fallback = "") {
  return process.env[name] === undefined ? fallback : process.env[name];
}

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

function resolveProjectPath(value) {
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(projectRoot, value);
}

function queueUrl(baseUrl, queue) {
  const url = new URL(baseUrl);
  url.searchParams.set("queue", queue);
  return url.toString();
}

function normalizeSection(section) {
  if (!section || !section.name || !section.url) {
    return null;
  }
  return {
    name: String(section.name),
    url: String(section.url),
    enabled: section.enabled === undefined ? true : parseBool(section.enabled, true)
  };
}

function loadSections(baseUrl) {
  const override = safeJsonParse(readEnv("SECTIONS_JSON", ""), null);
  if (Array.isArray(override)) {
    return override.map(normalizeSection).filter(Boolean).filter((section) => section.enabled);
  }

  const sections = [
    {
      name: "Recommended for you",
      url: queueUrl(baseUrl, "potluck"),
      enabled: true
    },
    {
      name: "Additional items",
      url: queueUrl(baseUrl, "encore"),
      enabled: true
    },
    {
      name: "All items",
      url: queueUrl(baseUrl, "last_chance"),
      enabled: parseBool(readEnv("SCAN_ALL_ITEMS", "false"), false)
    }
  ];

  const extras = safeJsonParse(readEnv("EXTRA_SECTIONS_JSON", "[]"), []);
  if (Array.isArray(extras)) {
    for (const extra of extras) {
      const section = normalizeSection(extra);
      if (section) {
        sections.push(section);
      }
    }
  }

  return sections.filter((section) => section.enabled);
}

function loadConfig(overrides = {}) {
  const amazonVineBaseUrl = readEnv("AMAZON_VINE_BASE_URL", "https://www.amazon.it/vine/vine-items");

  return {
    projectRoot,
    telegramBotToken: readEnv("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId: readEnv("TELEGRAM_CHAT_ID", ""),
    amazonVineBaseUrl,
    sections: loadSections(amazonVineBaseUrl),
    scanIntervalSeconds: parseNumber(readEnv("SCAN_INTERVAL_SECONDS", "30"), 30, 10),
    scanJitterSeconds: parseNumber(readEnv("SCAN_JITTER_SECONDS", "10"), 10, 0),
    minScoreToNotify: parseNumber(readEnv("MIN_SCORE_TO_NOTIFY", "15"), 15),
    maxNotificationsPerCycle: parseNumber(readEnv("MAX_NOTIFICATIONS_PER_CYCLE", "5"), 5, 1),
    headless: parseBool(readEnv("HEADLESS", "false"), false),
    pageTimeoutMs: parseNumber(readEnv("PAGE_TIMEOUT_SECONDS", "45"), 45, 5) * 1000,
    pageSettleMs: parseNumber(readEnv("PAGE_SETTLE_SECONDS", "3"), 3, 0) * 1000,
    sectionDelayMs: parseNumber(readEnv("SECTION_DELAY_SECONDS", "3"), 3, 0) * 1000,
    databasePath: resolveProjectPath(readEnv("DATABASE_PATH", "./data/vine-watcher.sqlite")),
    playwrightUserDataDir: resolveProjectPath(readEnv("PLAYWRIGHT_USER_DATA_DIR", "./data/chromium-profile")),
    logLevel: readEnv("LOG_LEVEL", "info"),
    notifyCriticalErrors: parseBool(readEnv("NOTIFY_CRITICAL_ERRORS", "true"), true),
    criticalNotificationCooldownMs:
      parseNumber(readEnv("CRITICAL_NOTIFICATION_COOLDOWN_SECONDS", "900"), 900, 60) * 1000,
    exitOnSessionAttention: parseBool(readEnv("EXIT_ON_SESSION_ATTENTION", "false"), false),
    keywords: keywordConfig,
    timezoneId: readEnv("TZ", "Europe/Rome"),
    ...overrides
  };
}

module.exports = {
  keywordConfig,
  loadConfig
};
