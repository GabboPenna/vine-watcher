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
    "zigbee2mqtt",
    "matter",
    "home assistant",
    "homeassistant",
    "z-wave",
    "z wave",
    "shelly",
    "aqara",
    "sonoff",
    "switchbot",
    "tado",
    "netatmo",
    "poe",
    "nvr",
    "ups",
    "inverter",
    "telecamera",
    "security camera",
    "surveillance camera",
    "videosorveglianza",
    "allarme",
    "alarm",
    "termostato",
    "thermostat",
    "cronotermostato",
    "videocitofono",
    "video doorbell",
    "serratura smart",
    "smart lock",
    "presa smart",
    "smart plug",
    "interruttore smart",
    "smart switch",
    "rele smart",
    "smart relay",
    "mmwave",
    "rilevatore",
    "detector",
    "misuratore energia",
    "energy meter",
    "wattmetro",
    "power meter",
    "termocamera",
    "thermal camera",
    "deumidificatore",
    "dehumidifier",
    "purificatore",
    "air purifier",
    "climatizzatore",
    "condizionatore",
    "air conditioner",
    "friggitrice ad aria",
    "air fryer",
    "robot cucina",
    "food processor",
    "planetaria",
    "stand mixer",
    "macchina sottovuoto",
    "vacuum sealer",
    "filtro hepa",
    "hepa filter",
    "filtro acqua",
    "water filter",
    "filtro carbone",
    "carbon filter",
    "decalcificante",
    "descaler",
    "cartuccia filtro",
    "filter cartridge",
    "macchina caffe",
    "coffee machine",
    "trapano",
    "drill",
    "avvitatore",
    "screwdriver",
    "utensile",
    "power tool",
    "idropulitrice",
    "pressure washer",
    "livella laser",
    "laser level",
    "pannello solare",
    "solar panel",
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
    "thread",
    "wireless",
    "mqtt",
    "esphome",
    "tasmota",
    "homekit",
    "hassio",
    "smart",
    "bluetooth",
    "ble",
    "usb-c",
    "elettrico",
    "professionale",
    "domotica",
    "cucina",
    "giardino",
    "sicurezza",
    "security",
    "sensore",
    "sensor",
    "sensore presenza",
    "presence sensor",
    "temperatura",
    "temperature",
    "umidita",
    "humidity",
    "movimento",
    "motion",
    "presenza",
    "presence",
    "apertura",
    "opening",
    "contatto",
    "contact",
    "fumo",
    "smoke",
    "monossido",
    "carbon monoxide",
    "perdita acqua",
    "water leak",
    "gas",
    "hub",
    "gateway",
    "bridge",
    "repeater",
    "mesh",
    "presa intelligente",
    "interruttore",
    "relay",
    "rele",
    "dimmer",
    "tapparella",
    "shutter",
    "valvola",
    "valve",
    "valvola termostatica",
    "thermostatic valve",
    "infrarossi",
    "infrared",
    "ir blaster",
    "energia",
    "energy",
    "consumo",
    "power consumption",
    "lampadina smart",
    "smart bulb",
    "striscia led",
    "led strip",
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
    "lavatrice",
    "washing machine",
    "asciugatrice",
    "dryer",
    "lavastoviglie",
    "dishwasher",
    "frigorifero",
    "refrigerator",
    "fridge",
    "congelatore",
    "freezer",
    "forno",
    "oven",
    "microonde",
    "microwave",
    "induzione",
    "induction",
    "bollitore",
    "kettle",
    "tostapane",
    "toaster",
    "impastatrice",
    "stand mixer",
    "frullatore",
    "blender",
    "mixer",
    "tritatutto",
    "chopper",
    "minipimer",
    "hand blender",
    "vaporiera",
    "steamer",
    "multicooker",
    "slow cooker",
    "macchina pane",
    "bread maker",
    "sottovuoto",
    "vacuum sealer",
    "purificatore aria",
    "air purifier",
    "umidificatore",
    "humidifier",
    "anticalcare",
    "descaler",
    "cartuccia acqua",
    "water cartridge",
    "sacchetti sottovuoto",
    "vacuum bags",
    "filtro aspirapolvere",
    "vacuum filter",
    "filtro lavastoviglie",
    "dishwasher filter",
    "filtro lavatrice",
    "washing machine filter",
    "filtro frigorifero",
    "fridge filter",
    "spazzola aspirapolvere",
    "vacuum brush",
    "rullo aspirapolvere",
    "vacuum roller",
    "sacchetto aspirapolvere",
    "vacuum bag",
    "sacchetti aspirapolvere",
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
    "shelly",
    "meross",
    "tado",
    "netatmo",
    "arlo",
    "eufy",
    "yeelight",
    "govee",
    "nanoleaf",
    "broadlink",
    "ikea",
    "tradfri",
    "hue",
    "tapo",
    "ring",
    "nest",
    "wyze",
    "shark",
    "cosori",
    "bosch",
    "makita",
    "black+decker",
    "philips",
    "xiaomi",
    "dreame",
    "cecotec",
    "de'longhi",
    "chicco",
    "ecovacs",
    "roborock",
    "dyson",
    "hoover",
    "bissell",
    "karcher",
    "levoit",
    "winix",
    "miele",
    "siemens",
    "electrolux",
    "ariete",
    "rowenta",
    "braun",
    "tefal",
    "kenwood",
    "kitchenaid",
    "ninja",
    "instant pot",
    "imou",
    "netgear",
    "logitech",
    "trust",
    "samsung",
    "sandisk",
    "crucial",
    "kingston"
  ],
  smartHomeKeywords: [
    "zigbee",
    "zigbee2mqtt",
    "matter",
    "mqtt",
    "esphome",
    "tasmota",
    "tuya",
    "wifi",
    "wi-fi",
    "wireless",
    "ble",
    "sensore",
    "sensor",
    "sensore presenza",
    "presence sensor",
    "motion sensor",
    "door sensor",
    "contact sensor",
    "smart",
    "home assistant",
    "homeassistant",
    "thread",
    "domotica",
    "z-wave",
    "z wave",
    "homekit",
    "shelly",
    "presa smart",
    "smart plug",
    "presa intelligente",
    "interruttore smart",
    "smart switch",
    "rele smart",
    "smart relay",
    "relay",
    "dimmer",
    "termostato",
    "thermostat",
    "cronotermostato",
    "valvola termostatica",
    "thermostatic valve",
    "tapparella",
    "shutter",
    "gateway",
    "bridge",
    "mmwave",
    "movimento",
    "motion",
    "presenza",
    "presence",
    "apertura",
    "opening",
    "contatto",
    "contact",
    "fumo",
    "smoke",
    "monossido",
    "carbon monoxide",
    "perdita acqua",
    "water leak",
    "ir blaster",
    "infrarossi",
    "infrared",
    "poe",
    "nvr"
  ],
  electronicsOrToolKeywords: [
    "elettronica",
    "electronics",
    "alimentatore",
    "power supply",
    "caricatore",
    "charger",
    "gan",
    "usb-c",
    "poe",
    "ups",
    "inverter",
    "nvr",
    "router",
    "switch",
    "ssd",
    "monitor",
    "nas",
    "mini pc",
    "trapano",
    "drill",
    "utensile",
    "power tool",
    "compressore",
    "compressor",
    "saldatore",
    "soldering iron",
    "multimetro",
    "multimeter",
    "wattmetro",
    "power meter",
    "misuratore energia",
    "energy meter",
    "pinza amperometrica",
    "clamp meter",
    "oscilloscopio",
    "oscilloscope",
    "termocamera",
    "thermal camera",
    "pannello solare",
    "solar panel",
    "avvitatore",
    "screwdriver",
    "idropulitrice",
    "pressure washer",
    "livella laser",
    "laser level",
    "telecamera",
    "stampante"
  ],
  homeApplianceKeywords: [
    "aspirapolvere",
    "vacuum cleaner",
    "robot vacuum",
    "lavapavimenti",
    "floor cleaner",
    "deumidificatore",
    "dehumidifier",
    "purificatore",
    "purificatore aria",
    "air purifier",
    "umidificatore",
    "humidifier",
    "climatizzatore",
    "condizionatore",
    "air conditioner",
    "lavatrice",
    "washing machine",
    "asciugatrice",
    "dryer",
    "lavastoviglie",
    "dishwasher",
    "frigorifero",
    "refrigerator",
    "fridge",
    "congelatore",
    "freezer",
    "forno",
    "oven",
    "microonde",
    "microwave",
    "induzione",
    "induction",
    "friggitrice ad aria",
    "air fryer",
    "robot cucina",
    "food processor",
    "planetaria",
    "stand mixer",
    "impastatrice",
    "frullatore",
    "blender",
    "tritatutto",
    "chopper",
    "macchina caffe",
    "coffee machine",
    "macchina sottovuoto",
    "vacuum sealer",
    "sottovuoto",
    "bollitore",
    "kettle",
    "tostapane",
    "toaster",
    "vaporiera",
    "steamer",
    "multicooker",
    "slow cooker",
    "macchina pane",
    "bread maker",
    "filtro hepa",
    "hepa filter",
    "filtro acqua",
    "water filter",
    "filtro carbone",
    "carbon filter",
    "decalcificante",
    "descaler",
    "sacchetti sottovuoto",
    "vacuum bags",
    "filtro aspirapolvere",
    "vacuum filter",
    "spazzola aspirapolvere",
    "vacuum brush",
    "rullo aspirapolvere",
    "vacuum roller"
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

function parseTimestampMs(value) {
  const text = String(value || "").trim();
  if (!text) {
    return 0;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 100000000000 ? numeric : numeric * 1000;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseList(value, fallback = []) {
  const text = String(value || "").trim();
  if (!text) {
    return fallback;
  }
  return text
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
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
  const panicWindowMinutes = parseNumber(readEnv("PANIC_WINDOW_MINUTES", "0"), 0, 0);
  const panicUntilMs =
    parseTimestampMs(readEnv("PANIC_UNTIL", "")) ||
    (panicWindowMinutes > 0 ? Date.now() + panicWindowMinutes * 60 * 1000 : 0);

  return {
    projectRoot,
    telegramBotToken: readEnv("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId: readEnv("TELEGRAM_CHAT_ID", ""),
    telegramControlEnabled: parseBool(readEnv("TELEGRAM_CONTROL_ENABLED", "false"), false),
    telegramControlPollSeconds: parseNumber(readEnv("TELEGRAM_CONTROL_POLL_SECONDS", "3"), 3, 1),
    telegramControlLanguage: readEnv("TELEGRAM_CONTROL_LANGUAGE", "en"),
    amazonVineBaseUrl,
    sections: loadSections(amazonVineBaseUrl),
    scanIntervalSeconds: parseNumber(readEnv("SCAN_INTERVAL_SECONDS", "30"), 30, 10),
    scanJitterSeconds: parseNumber(readEnv("SCAN_JITTER_SECONDS", "10"), 10, 0),
    panicMode: parseBool(readEnv("PANIC_MODE", "false"), false),
    panicUntilMs,
    panicScanIntervalSeconds: parseNumber(readEnv("PANIC_SCAN_INTERVAL_SECONDS", "10"), 10, 5),
    panicScanJitterSeconds: parseNumber(readEnv("PANIC_SCAN_JITTER_SECONDS", "3"), 3, 0),
    notifyAllProducts: parseBool(readEnv("NOTIFY_ALL_PRODUCTS", "false"), false),
    notifyAllProductsWindow: readEnv("NOTIFY_ALL_PRODUCTS_WINDOW", "").trim(),
    minScoreToNotify: parseNumber(readEnv("MIN_SCORE_TO_NOTIFY", "20"), 20),
    minValueToNotifyEur: parseNumber(readEnv("MIN_VALUE_TO_NOTIFY_EUR", "50"), 50, 0),
    strictNotifyMode: parseBool(readEnv("STRICT_NOTIFY_MODE", "true"), true),
    strictMinPositiveSignals: parseNumber(readEnv("STRICT_MIN_POSITIVE_SIGNALS", "2"), 2, 0),
    strictMaxNegativeSignals: parseNumber(readEnv("STRICT_MAX_NEGATIVE_SIGNALS", "0"), 0, 0),
    maxNotificationsPerCycle: parseNumber(readEnv("MAX_NOTIFICATIONS_PER_CYCLE", "5"), 5, 1),
    headless: parseBool(readEnv("HEADLESS", "false"), false),
    chromiumNoSandbox: parseBool(readEnv("CHROMIUM_NO_SANDBOX", "false"), false),
    pageTimeoutMs: parseNumber(readEnv("PAGE_TIMEOUT_SECONDS", "45"), 45, 5) * 1000,
    waitForNetworkIdle: parseBool(readEnv("WAIT_FOR_NETWORK_IDLE", "false"), false),
    productReadyTimeoutMs: parseNumber(readEnv("PRODUCT_READY_TIMEOUT_SECONDS", "5"), 5, 1) * 1000,
    pageSettleMs: parseNumber(readEnv("PAGE_SETTLE_SECONDS", "1"), 1, 0) * 1000,
    sectionDelayMs: parseNumber(readEnv("SECTION_DELAY_SECONDS", "1"), 1, 0) * 1000,
    blockedResourceTypes: parseList(readEnv("BLOCK_RESOURCE_TYPES", "font,media"), ["font", "media"]),
    databasePath: resolveProjectPath(readEnv("DATABASE_PATH", "./data/vine-watcher.sqlite")),
    playwrightUserDataDir: resolveProjectPath(readEnv("PLAYWRIGHT_USER_DATA_DIR", "./data/chromium-profile")),
    logLevel: readEnv("LOG_LEVEL", "info"),
    notifyCriticalErrors: parseBool(readEnv("NOTIFY_CRITICAL_ERRORS", "true"), true),
    criticalNotificationCooldownMs:
      parseNumber(readEnv("CRITICAL_NOTIFICATION_COOLDOWN_SECONDS", "900"), 900, 60) * 1000,
    sessionAttentionMaxFailures: parseNumber(readEnv("SESSION_ATTENTION_MAX_FAILURES", "2"), 2, 1),
    sessionAttentionCooldownMs:
      parseNumber(readEnv("SESSION_ATTENTION_COOLDOWN_SECONDS", "300"), 300, 60) * 1000,
    verifySessionAttention: parseBool(readEnv("VERIFY_SESSION_ATTENTION", "true"), true),
    sessionAttentionGraceMs:
      parseNumber(readEnv("SESSION_ATTENTION_GRACE_SECONDS", "300"), 300, 0) * 1000,
    sessionFailureBackoffMs:
      parseNumber(readEnv("SESSION_FAILURE_BACKOFF_SECONDS", "90"), 90, 10) * 1000,
    stopOnSessionAttention: parseBool(
      readEnv("STOP_ON_SESSION_ATTENTION", readEnv("EXIT_ON_SESSION_ATTENTION", "true")),
      true
    ),
    keywords: keywordConfig,
    timezoneId: readEnv("TZ", "Europe/Rome"),
    ...overrides
  };
}

module.exports = {
  keywordConfig,
  loadConfig
};
