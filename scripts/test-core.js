"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const { loadConfig, validateConfig } = require("../src/config");
const { helpMessage, parseCommand, TelegramControl } = require("../src/control");
const { startHealthServer } = require("../src/health-server");
const {
  isNotifyAllProductsActive,
  isTransientScanError,
  isTimeWindowActive,
  notificationTriggers,
  runCycle,
  scannerConfigForCycle,
  shouldDeferSessionAttention
} = require("../src/index");
const { applyRuntimeSettings } = require("../src/runtime-config");
const {
  classifySessionStatus,
  SectionPageInvalidError,
  sectionHardTimeoutMs,
  SessionNeedsAttentionError,
  VineScanner
} = require("../src/scanner");
const { memoryRecycleThresholdMb } = require("../src/scheduler");
const { scoreProduct } = require("../src/scorer");
const { ProductStorage } = require("../src/storage");
const { TelegramClient } = require("../src/telegram");
const { canonicalizeAmazonUrl, parseEuroValue } = require("../src/utils");

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  }
};

function testEuroParsing() {
  const euro = "\u20ac";
  assert.equal(parseEuroValue(`94,99${euro} 94 , 99${euro}`), 94.99);
  assert.equal(parseEuroValue(`${euro}109,99`), 109.99);
  assert.equal(parseEuroValue(`99${euro}`), 99);
  assert.equal(parseEuroValue("110 * 70 * 48,55 mm"), null);
}

function testUrlCanonicalization() {
  assert.equal(
    canonicalizeAmazonUrl("https://www.amazon.it/gp/product/B002KTID3A/ref=ewc_pr_img_26"),
    "https://www.amazon.it/dp/B002KTID3A"
  );
}

function testScoringAndTriggers() {
  const config = loadConfig({
    notifyAllProducts: false,
    notifyAllProductsWindow: "",
    minScoreToNotify: 20,
    minValueToNotifyEur: 35,
    strictNotifyMode: true,
    strictMinPositiveSignals: 2,
    strictMaxNegativeSignals: 0
  });

  const scored = scoreProduct(
    {
      title: "Bosch trapano professionale smart",
      raw_text: "",
      section: "Recommended for you"
    },
    config.keywords
  );
  assert.ok(scored.score >= 20);
  assert.ok(scored.positiveSignals >= 2);

  assert.deepEqual(
    notificationTriggers(
      { estimated_value_eur: 40 },
      { score: -10, positiveSignals: 0, negativeSignals: 2 },
      config
    ),
    ["estimated value \u20ac40.00 >= \u20ac35.00"]
  );

  assert.deepEqual(
    notificationTriggers(
      { estimated_value_eur: null },
      { score: -50, positiveSignals: 0, negativeSignals: 5 },
      { ...config, notifyAllProducts: true }
    ),
    ["notify all products mode"]
  );

  assert.deepEqual(
    notificationTriggers(
      { estimated_value_eur: null },
      { score: -50, positiveSignals: 0, negativeSignals: 5 },
      { ...config, notifyAllProductsWindow: "09:00-22:30", timezoneId: "Europe/Rome" },
      Date.parse("2026-06-19T07:00:00Z")
    ),
    ["notify all products window 09:00-22:30"]
  );

  assert.equal(
    notificationTriggers(
      { estimated_value_eur: null },
      { score: -50, positiveSignals: 0, negativeSignals: 5 },
      { ...config, notifyAllProductsWindow: "09:00-22:30", timezoneId: "Europe/Rome" },
      Date.parse("2026-06-19T20:30:00Z")
    ).length,
    0
  );

  assert.equal(
    notificationTriggers(
      { estimated_value_eur: null },
      { score: 25, positiveSignals: 2, negativeSignals: 1 },
      config
    ).length,
    0
  );

  const smartHomeScored = scoreProduct(
    {
      title: "Sensore presenza mmwave Zigbee2MQTT per Home Assistant",
      raw_text: "",
      section: "Additional items"
    },
    config.keywords
  );
  assert.ok(smartHomeScored.score >= 20);
  assert.ok(smartHomeScored.positiveSignals >= 2);
  assert.ok(smartHomeScored.reasons.includes("bonus: smart home"));

  const applianceScored = scoreProduct(
    {
      title: "Filtro HEPA aspirapolvere lavabile",
      raw_text: "",
      section: "Additional items"
    },
    config.keywords
  );
  assert.ok(applianceScored.score >= 20);
  assert.ok(applianceScored.positiveSignals >= 2);
  assert.ok(applianceScored.reasons.includes("bonus: home appliance or household"));

  const englishSmartHomeScored = scoreProduct(
    {
      title: "Matter Thread smart plug with power meter for Home Assistant",
      raw_text: "",
      section: "Additional items"
    },
    config.keywords
  );
  assert.ok(englishSmartHomeScored.score >= 20);
  assert.ok(englishSmartHomeScored.positiveSignals >= 2);
  assert.ok(englishSmartHomeScored.reasons.includes("bonus: smart home"));

  const englishApplianceScored = scoreProduct(
    {
      title: "HEPA filter replacement kit for robot vacuum cleaner",
      raw_text: "",
      section: "Additional items"
    },
    config.keywords
  );
  assert.ok(englishApplianceScored.score >= 20);
  assert.ok(englishApplianceScored.positiveSignals >= 2);
  assert.ok(englishApplianceScored.reasons.includes("bonus: home appliance or household"));

  const genericDinEnclosureScored = scoreProduct(
    {
      title: "DIN Rail Enclosure scatola elettrica per elettronica domotica",
      raw_text: "",
      section: "Additional items"
    },
    config.keywords
  );
  assert.ok(genericDinEnclosureScored.score < 20);
}

function testNotifyAllProductWindow() {
  assert.equal(isTimeWindowActive("09:00-22:30", "Europe/Rome", Date.parse("2026-06-19T06:59:00Z")), false);
  assert.equal(isTimeWindowActive("09:00-22:30", "Europe/Rome", Date.parse("2026-06-19T07:00:00Z")), true);
  assert.equal(isTimeWindowActive("09:00-22:30", "Europe/Rome", Date.parse("2026-06-19T20:29:00Z")), true);
  assert.equal(isTimeWindowActive("09:00-22:30", "Europe/Rome", Date.parse("2026-06-19T20:30:00Z")), false);
  assert.equal(isTimeWindowActive("22:00-06:00", "Europe/Rome", Date.parse("2026-06-19T21:00:00Z")), true);
  assert.equal(isTimeWindowActive("22:00-06:00", "Europe/Rome", Date.parse("2026-06-19T03:59:00Z")), true);
  assert.equal(isTimeWindowActive("22:00-06:00", "Europe/Rome", Date.parse("2026-06-19T12:00:00Z")), false);
  assert.equal(isTimeWindowActive("bad", "Europe/Rome", Date.parse("2026-06-19T12:00:00Z")), false);

  assert.equal(
    isNotifyAllProductsActive(
      {
        notifyAllProducts: false,
        notifyAllProductsWindow: "09:00-22:30",
        timezoneId: "Europe/Rome"
      },
      Date.parse("2026-06-19T07:00:00Z")
    ),
    true
  );
}

function testRuntimeSettings() {
  const baseConfig = loadConfig({
    notifyAllProducts: false,
    notifyAllProductsWindow: "",
    minScoreToNotify: 20,
    minValueToNotifyEur: 50,
    telegramControlLanguage: "en",
    panicScanIntervalSeconds: 10
  });
  const config = applyRuntimeSettings(baseConfig, {
    notify_all_products: "true",
    notify_all_products_window: "09:00-22:30",
    min_score_to_notify: "5",
    min_value_to_notify_eur: "35",
    control_language: "it",
    panic_scan_interval_seconds: "2",
    section_hard_timeout_seconds: "24",
    section_scan_concurrency: "2",
    reuse_section_pages: "true",
    scanner_turbo_only_during_adaptive_active: "true"
  });

  assert.equal(config.notifyAllProducts, true);
  assert.equal(config.notifyAllProductsWindow, "09:00-22:30");
  assert.equal(config.minScoreToNotify, 5);
  assert.equal(config.minValueToNotifyEur, 35);
  assert.equal(config.telegramControlLanguage, "it");
  assert.equal(config.panicScanIntervalSeconds, 5);
  assert.equal(config.sectionHardTimeoutMs, 24000);
  assert.equal(config.sectionScanConcurrency, 2);
  assert.equal(config.reuseSectionPages, true);
  assert.equal(config.scannerTurboOnlyDuringAdaptiveActive, true);
}

function testConfigValidation() {
  const config = loadConfig();
  assert.throws(
    () =>
      validateConfig({
        ...config,
        sections: [
          { name: "Duplicate", url: "https://www.amazon.it/vine/vine-items?queue=potluck" },
          { name: "Duplicate", url: "https://www.amazon.it/vine/vine-items?queue=encore" }
        ]
      }),
    /Duplicate Vine section name/
  );
  assert.throws(
    () => validateConfig({ ...config, notifyAllProductsWindow: "25:00-26:00" }),
    /Invalid NOTIFY_ALL_PRODUCTS_WINDOW/
  );
  assert.throws(
    () => validateConfig({ ...config, detailValueLookupRetryBaseMs: 60000, detailValueLookupRetryMaxMs: 30000 }),
    /RETRY_MAX_SECONDS/
  );
}

function testExternalScoringRules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vine-watcher-rules-"));
  const previousPath = process.env.SCORING_RULES_PATH;
  const previousJson = process.env.SCORING_RULES_JSON;

  try {
    const rulesPath = path.join(dir, "rules.yml");
    fs.writeFileSync(
      rulesPath,
      [
        "append:",
        "  positiveKeywordsHigh:",
        "    - custom-widget",
        "  smartHomeKeywords:",
        "    - thread border router"
      ].join("\n"),
      "utf8"
    );
    process.env.SCORING_RULES_PATH = rulesPath;
    delete process.env.SCORING_RULES_JSON;

    const yamlConfig = loadConfig();
    assert.equal(yamlConfig.scoringRulesLoaded, true);
    assert.ok(yamlConfig.keywords.positiveKeywordsHigh.includes("custom-widget"));
    assert.ok(yamlConfig.keywords.smartHomeKeywords.includes("thread border router"));

    process.env.SCORING_RULES_JSON = JSON.stringify({
      append: {
        positiveKeywordsHigh: ["json-widget"]
      }
    });
    delete process.env.SCORING_RULES_PATH;

    const jsonConfig = loadConfig();
    assert.ok(jsonConfig.keywords.positiveKeywordsHigh.includes("json-widget"));
  } finally {
    if (previousPath === undefined) {
      delete process.env.SCORING_RULES_PATH;
    } else {
      process.env.SCORING_RULES_PATH = previousPath;
    }
    if (previousJson === undefined) {
      delete process.env.SCORING_RULES_JSON;
    } else {
      process.env.SCORING_RULES_JSON = previousJson;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testScannerFixtures() {
  const fixtures = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../test-fixtures/raw-products.json"), "utf8")
  );
  const config = loadConfig();
  const scanner = new VineScanner({
    context: null,
    config,
    logger: silentLogger
  });

  for (const fixture of fixtures) {
    const product = scanner.normalizeProduct(fixture.raw, fixture.section);
    const scoring = scoreProduct(product, config.keywords);
    assert.equal(product.asin, fixture.expected.asin, fixture.name);
    assert.equal(product.url, fixture.expected.url, fixture.name);
    assert.equal(product.section, fixture.expected.section, fixture.name);
    assert.equal(product.estimated_value_eur, fixture.expected.estimated_value_eur, fixture.name);
    assert.ok(scoring.score >= fixture.expected.minimum_score, fixture.name);
  }
}

async function testScannerDetailValueLookup() {
  const calls = [];
  let disposedResponses = 0;
  const scanner = new VineScanner({
    context: {
      request: {
        async get(url, options = {}) {
          calls.push({ url, timeout: options.timeout });
          return {
            ok() {
              return true;
            },
            status() {
              return 200;
            },
            async json() {
              if (url.includes("/item/")) {
                return {
                  result: {
                    asin: "B0VARIANT1",
                    imageUrl: "https://m.media-amazon.com/images/I/example._SS180_.jpg",
                    taxCurrency: "EUR",
                    taxValue: 24.99
                  },
                  error: null
                };
              }
              return {
                result: {
                  recommendationId: "APJ#B0PARENT01#vine.enrollment.test",
                  item: null,
                  variations: [
                    {
                      asin: "B0VARIANT1",
                      dimensions: {
                        Color: "Pink"
                      }
                    }
                  ]
                },
                error: null
              };
            },
            async dispose() {
              disposedResponses += 1;
            }
          };
        }
      }
    },
    config: loadConfig({
      detailValueLookupEnabled: true,
      detailValueLookupTimeoutMs: 4000,
      amazonVineBaseUrl: "https://www.amazon.it/vine/vine-items"
    }),
    logger: silentLogger
  });

  const enriched = await scanner.enrichProductValue({
    asin: "B0PARENT01",
    title: "Small desk fan",
    section_url: "https://www.amazon.it/vine/vine-items?queue=encore",
    image_url: "",
    estimated_value_eur: null,
    vine_recommendation_id: "APJ#B0PARENT01#vine.enrollment.test"
  });

  assert.equal(enriched.estimated_value_eur, 24.99);
  assert.equal(enriched.image_url, "https://m.media-amazon.com/images/I/example._SS180_.jpg");
  assert.equal(calls.length, 2);
  assert.equal(disposedResponses, 2);
  assert.match(calls[1].url, /\/item\/B0VARIANT1\?imageSize=180$/);
}

async function testScannerRejectsHttpFailureAndRetries() {
  let pagesCreated = 0;
  let pagesClosed = 0;
  const context = {
    async newPage() {
      pagesCreated += 1;
      let closed = false;
      return {
        isClosed() {
          return closed;
        },
        async close() {
          closed = true;
          pagesClosed += 1;
        },
        async goto() {
          return {
            status() {
              return 503;
            }
          };
        }
      };
    }
  };
  const scanner = new VineScanner({
    context,
    config: loadConfig({
      sections: [{ name: "Retry section", url: "https://www.amazon.it/vine/vine-items?queue=encore" }],
      sectionNavigationRetries: 1,
      sectionNavigationRetryDelayMs: 0,
      reuseSectionPages: false
    }),
    logger: silentLogger
  });

  await assert.rejects(scanner.scanSection(scanner.config.sections[0]), SectionPageInvalidError);
  assert.equal(pagesCreated, 2);
  assert.equal(pagesClosed, 2);
}

function testMemoryRecycleThresholdUsesGrowth() {
  assert.equal(
    memoryRecycleThresholdMb({ browserMemoryRecycleMb: 1200, browserMemoryRecycleMinGrowthMb: 256 }, 1200),
    1456
  );
  assert.equal(
    memoryRecycleThresholdMb({ browserMemoryRecycleMb: 1500, browserMemoryRecycleMinGrowthMb: 256 }, 1000),
    1500
  );
}

function testStorageEstimatedValue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vine-watcher-test-"));
  const dbPath = path.join(dir, "products.sqlite");
  const storage = new ProductStorage(dbPath, silentLogger);
  storage.init();

  const product = {
    asin: "B002KTID3A",
    title: "Bosch drill bit set",
    normalized_title: "bosch drill bit set",
    url: "https://www.amazon.it/dp/B002KTID3A",
    section_url: "https://www.amazon.it/vine/vine-items?queue=potluck",
    section: "Recommended for you",
    image_url: "",
    estimated_value_eur: 42.5,
    vine_recommendation_id: "APJ#B002KTID3A#vine.enrollment.test",
    vine_card_asin: "B002KTID3A",
    vine_recommendation_type: "SEARCH",
    raw_text: "42,50\u20ac"
  };

  const saved = storage.saveProduct(product, { score: 25, reasons: ["brand: bosch"] }, {
    inventoryAt: "2026-06-20T10:00:00.000Z",
    triggers: ["score 25 >= 20"],
    blockers: ["no blockers"],
    configSnapshot: { minScoreToNotify: 20 },
    decision: "candidate"
  });
  assert.equal(
    storage.db.prepare("select estimated_value_eur from products where asin = ?").get(product.asin).estimated_value_eur,
    42.5
  );
  assert.equal(saved.product.present_now, 1);
  assert.equal(JSON.parse(saved.product.last_triggers_json)[0], "score 25 >= 20");
  assert.equal(saved.product.vine_recommendation_id, product.vine_recommendation_id);
  assert.equal(saved.product.identity_key, `asin:${product.asin}`);

  storage.saveProduct({ ...product, estimated_value_eur: null, raw_text: "" }, { score: 25, reasons: [] }, {
    inventoryAt: "2026-06-20T10:01:00.000Z",
    decision: "no_trigger"
  });
  assert.equal(
    storage.db.prepare("select estimated_value_eur from products where asin = ?").get(product.asin).estimated_value_eur,
    42.5
  );

  const sameTitleDifferentAsin = storage.saveProduct(
    {
      ...product,
      asin: "B002KTID3B",
      url: "https://www.amazon.it/dp/B002KTID3B",
      vine_recommendation_id: "APJ#B002KTID3B#vine.enrollment.test",
      vine_card_asin: "B002KTID3B"
    },
    { score: 25, reasons: ["brand: bosch"] },
    { inventoryAt: "2026-06-20T10:01:30.000Z", decision: "candidate" }
  );
  assert.equal(sameTitleDifferentAsin.isNew, true);
  assert.notEqual(sameTitleDifferentAsin.product.id, saved.product.id);
  assert.equal(
    storage.db.prepare("select count(*) as count from products where normalized_title = ?").get(product.normalized_title).count,
    2
  );

  const marked = storage.markNotified(saved.product.id, { kind: "photo", chatId: 123, messageId: 456 });
  assert.equal(marked.telegram_chat_id, "123");
  assert.equal(marked.telegram_message_id, 456);
  const attempted = storage.recordValueLookupAttempt(saved.product.id, {
    found: false,
    nextAt: "2026-06-20T11:00:00.000Z"
  });
  assert.equal(attempted.value_lookup_attempts, 1);
  assert.equal(attempted.value_lookup_status, "missing");
  assert.equal(storage.markMissingProducts("2026-06-20T10:02:00.000Z"), 2);
  assert.equal(storage.recentProducts({ mode: "gone", limit: 1 })[0].present_now, 0);
  storage.saveProduct(product, { score: 25, reasons: ["brand: bosch"] }, {
    inventoryAt: "2026-06-20T10:03:00.000Z",
    decision: "candidate"
  });
  const reappeared = storage.searchProducts("bosch", 1)[0];
  assert.equal(reappeared.present_now, 1);
  assert.equal(reappeared.reappeared_count, 1);

  storage.saveProduct(
    {
      asin: "B0ADDITIONAL",
      title: "Additional item",
      normalized_title: "additional item",
      url: "https://www.amazon.it/dp/B0ADDITIONAL",
      section_url: "https://www.amazon.it/vine/vine-items?queue=encore",
      section: "Additional items",
      image_url: "",
      estimated_value_eur: null,
      raw_text: ""
    },
    { score: 0, reasons: [] },
    {
      inventoryAt: "2026-06-20T10:03:00.000Z",
      decision: "candidate"
    }
  );
  assert.equal(storage.markMissingProducts("2026-06-20T10:04:00.000Z", ["Additional items"]), 1);
  assert.equal(storage.searchProducts("additional", 1)[0].present_now, 0);
  assert.equal(storage.searchProducts("bosch", 1)[0].present_now, 1);

  storage.setSetting("min_score_to_notify", "5");
  assert.equal(storage.getSetting("min_score_to_notify"), "5");
  assert.deepEqual(storage.getSettings().min_score_to_notify, "5");
  storage.deleteSetting("min_score_to_notify");
  assert.equal(storage.getSetting("min_score_to_notify", "fallback"), "fallback");

  storage.recordScanCycle({
    startedAt: "2026-06-20T10:00:00.000Z",
    completedAt: "2026-06-20T10:00:07.000Z",
    scanned: 2,
    newProducts: 1,
    notified: 1,
    maxScore: 25,
    elapsedSeconds: "7.0",
    outcome: "sent_notifications",
    reasonNoNotifications: "sent notifications",
    sections: [{ name: "Additional items", scanned: 2 }],
    layoutWarnings: ["fixture warning"]
  });
  assert.equal(storage.recentScanCycles(1)[0].outcome, "sent_notifications");
  assert.equal(JSON.parse(storage.recentScanCycles(1)[0].layout_warnings_json)[0], "fixture warning");
  storage.recordScanCycle({
    startedAt: "2026-06-20T10:01:00.000Z",
    completedAt: "2026-06-20T10:01:20.000Z",
    success: false,
    failureKind: "transient_scan_failure",
    error: "page.goto timed out",
    outcome: "transient_scan_failure"
  });
  const failedCycle = storage.recentScanCycles(1)[0];
  assert.equal(failedCycle.success, 0);
  assert.equal(failedCycle.failure_kind, "transient_scan_failure");
  assert.equal(storage.searchProducts("bosch", 1)[0].asin, product.asin);
  assert.ok(storage.recentProducts({ mode: "all", limit: 2 }).some((row) => row.asin === product.asin));
  const cleanup = storage.cleanup({ productDays: 1, scanCycleDays: 1, vacuum: false });
  assert.equal(cleanup.vacuumed, false);

  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testTelegramControlCommands() {
  const settings = {};
  const sentMessages = [];
  const sentProducts = [];
  const editedMessages = [];
  const answeredCallbacks = [];
  const registeredCommands = [];
  let menuButtonRegistered = false;
  const storedProducts = [
    {
      id: 101,
      asin: "B002KTID3A",
      title: "Bosch trapano smart",
      normalized_title: "bosch trapano smart",
      url: "https://www.amazon.it/dp/B002KTID3A",
      section_url: "https://www.amazon.it/vine/vine-items?queue=encore",
      image_url: "",
      section: "Additional items",
      estimated_value_eur: 42,
      first_seen_at: "2026-06-20T10:00:00.000Z",
      last_seen_at: "2026-06-20T10:05:00.000Z",
      score: 25,
      reasons_json: JSON.stringify(["brand: bosch"]),
      notified: 0,
      present_now: 1,
      raw_text: "Bosch trapano smart"
    }
  ];
  const fakeStorage = {
    getSettings() {
      return { ...settings };
    },
    getSetting(key, fallback = "") {
      return settings[key] === undefined ? fallback : settings[key];
    },
    setSetting(key, value) {
      settings[key] = String(value);
    },
    deleteSetting(key) {
      delete settings[key];
    },
    searchProducts(query, limit) {
      const normalized = String(query || "").toLowerCase();
      return storedProducts
        .filter((product) => product.title.toLowerCase().includes(normalized))
        .slice(0, limit);
    },
    recentProducts({ limit, mode = "all" } = {}) {
      let products = storedProducts;
      if (mode === "present") {
        products = products.filter((product) => product.present_now === 1);
      } else if (mode === "notified") {
        products = products.filter((product) => product.notified === 1);
      } else if (mode === "unnotified" || mode === "ignored") {
        products = products.filter((product) => product.notified !== 1);
      }
      return products.slice(0, limit || 10);
    },
    recentScanCycles() {
      return [
        {
          completed_at: "2026-06-20T10:06:00.000Z",
          scanned: 3,
          new_products: 1,
          notified: 1,
          outcome: "sent_notifications"
        }
      ];
    },
    getStats() {
      return {
        totals: {
          total: storedProducts.length,
          notified: storedProducts.filter((product) => product.notified === 1).length,
          max_score: 25
        },
        topProducts: storedProducts
      };
    },
    markNotified(productId) {
      const product = storedProducts.find((item) => item.id === productId);
      if (product) {
        product.notified = 1;
      }
    }
  };
  const fakeTelegram = {
    enabled: true,
    async getUpdates() {
      return [];
    },
    async sendText(text, options = {}) {
      sentMessages.push({ text, options });
      return true;
    },
    async sendProduct(product, scoring) {
      sentProducts.push({ product, scoring });
      return true;
    },
    async editText(chatId, messageId, text, options = {}) {
      editedMessages.push({ chatId, messageId, text, options });
      return true;
    },
    async answerCallbackQuery(id, text) {
      answeredCallbacks.push({ id, text });
      return true;
    },
    async setCommands(commands) {
      registeredCommands.push(commands);
      return true;
    },
    async setChatMenuButton() {
      menuButtonRegistered = true;
      return true;
    }
  };
  const control = new TelegramControl({
    telegram: fakeTelegram,
    storage: fakeStorage,
    getConfig: () =>
      applyRuntimeSettings(
        loadConfig({
          telegramBotToken: "123456:test-token",
          telegramChatId: "123",
          telegramControlEnabled: true,
          telegramControlLanguage: "it",
          notifyAllProducts: false,
          notifyAllProductsWindow: "",
          minScoreToNotify: 20,
          minValueToNotifyEur: 50,
          strictNotifyMode: true,
          strictMinPositiveSignals: 2,
          strictMaxNegativeSignals: 0,
          maxNotificationsPerCycle: 5,
          panicMode: false,
          panicUntilMs: 0,
          panicScanIntervalSeconds: 10,
          panicScanJitterSeconds: 3,
          scanIntervalSeconds: 30,
          scanJitterSeconds: 10,
          adaptiveScanEnabled: false,
          adaptiveIdleAfterCycles: 5,
          adaptiveIdleIntervalSeconds: 60,
          adaptiveActiveCycles: 3,
          adaptiveActiveIntervalSeconds: 15,
          adaptiveActiveJitterSeconds: 3,
          pageTimeoutMs: 45000,
          productReadyTimeoutMs: 5000,
          pageSettleMs: 1000,
          sectionDelayMs: 1000
        }),
        settings
      ),
    getStatus: () => ({
      lastCycle: {
        scanned: 2,
        newProducts: 1,
        notified: 1,
        maxScore: 25,
        elapsedSeconds: "1.5"
      }
    }),
    logger: silentLogger
  });

  assert.deepEqual(parseCommand("/status@MyBot now"), {
    command: "/status",
    args: ["now"]
  });
  await control.registerCommands();
  assert.ok(registeredCommands[0].some((command) => command.command === "menu"));
  assert.equal(menuButtonRegistered, true);

  assert.match(helpMessage("it"), /Comandi principali/);
  const menu = await control.executeCommand("/menu");
  assert.match(menu.text, /Control Panel/);
  assert.ok(menu.options.reply_markup.inline_keyboard.length > 0);
  assert.match(await control.executeCommand("/help"), /Vine Watcher Control/);
  assert.match(await control.executeCommand("/status"), /Ultimo giro/);

  assert.match(await control.executeCommand("/lang en"), /Language set/);
  assert.equal(settings.control_language, "en");
  assert.match(await control.executeCommand("/notify_all on"), /notify_all_products=true/);
  assert.equal(settings.notify_all_products, "true");
  assert.match(await control.executeCommand("/notify_all_window 09:00-22:30"), /09:00-22:30/);
  assert.equal(settings.notify_all_products_window, "09:00-22:30");
  assert.match(await control.executeCommand("/notify_all always"), /notify_all_products=true/);
  assert.equal(settings.notify_all_products, "true");
  assert.equal(settings.notify_all_products_window, "");
  assert.match(await control.executeCommand("/min_score 5"), /min_score_to_notify=5/);
  assert.equal(settings.min_score_to_notify, "5");
  assert.match(await control.executeCommand("/min_value 35"), /min_value_to_notify_eur=35/);
  assert.equal(settings.min_value_to_notify_eur, "35");
  assert.match(await control.executeCommand("/strict_signals 3 1"), /strict_min_positive_signals=3/);
  assert.equal(settings.strict_min_positive_signals, "3");
  assert.equal(settings.strict_max_negative_signals, "1");
  assert.match(await control.executeCommand("/adaptive on"), /adaptive_scan_enabled=true/);
  assert.equal(settings.adaptive_scan_enabled, "true");
  assert.match(await control.executeCommand("/adaptive 4 45 4 12 2"), /idle_after=4/);
  assert.equal(settings.adaptive_idle_after_cycles, "4");
  assert.equal(settings.adaptive_idle_interval_seconds, "45");
  assert.equal(settings.adaptive_active_cycles, "4");
  assert.equal(settings.adaptive_active_interval_seconds, "12");
  assert.equal(settings.adaptive_active_jitter_seconds, "2");
  assert.match(await control.executeCommand("/adaptive"), /Adaptive scheduler/);
  assert.match(await control.executeCommand("/fast on"), /fast profile on/);
  assert.equal(settings.panic_mode, "true");
  assert.equal(settings.panic_scan_interval_seconds, "5");
  assert.match(await control.executeCommand("/profile drop"), /profile=drop/);
  assert.equal(settings.scan_interval_seconds, "10");
  assert.equal(settings.browser_memory_recycle_mb, "1500");
  assert.match(await control.executeCommand("/latest 1"), /Bosch trapano smart/);
  assert.match(await control.executeCommand("/latest present 1"), /Bosch trapano smart/);
  assert.match(await control.executeCommand("/dashboard"), /Saved products|Prodotti salvati/);
  assert.match(await control.executeCommand("/why trapano"), /Bosch trapano smart/);
  assert.match(await control.executeCommand("/replay trapano 1"), /1\/1/);
  assert.equal(sentProducts.length, 1);
  assert.equal(storedProducts[0].notified, 1);
  assert.match(await control.executeCommand("/replay present 20"), /1\/1/);
  assert.equal(sentProducts.length, 2);
  assert.match(await control.executeCommand("/reset notify_all_window"), /reset/);
  assert.equal(settings.notify_all_products_window, undefined);
  assert.match(await control.executeCommand("/reset min_score_to_notify"), /reset/);
  assert.equal(settings.min_score_to_notify, undefined);

  await control.handleUpdate({
    update_id: 10,
    message: {
      chat: { id: 999 },
      text: "/status"
    }
  });
  assert.equal(sentMessages.length, 0);

  await control.handleUpdate({
    update_id: 11,
    message: {
      chat: { id: 123 },
      text: "/config"
    }
  });
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Effective configuration/);

  await control.handleUpdate({
    update_id: 12,
    message: {
      chat: { id: 123 },
      text: "/menu"
    }
  });
  assert.equal(sentMessages.length, 2);
  assert.ok(sentMessages[1].options.reply_markup.inline_keyboard.length > 0);
  assert.ok(
    sentMessages[1].options.reply_markup.inline_keyboard
      .flat()
      .some((button) => button.callback_data === "vw:notify_all:always")
  );
  assert.ok(
    sentMessages[1].options.reply_markup.inline_keyboard
      .flat()
      .some((button) => button.callback_data === "vw:adaptive:default")
  );

  await control.handleUpdate({
    update_id: 13,
    callback_query: {
      id: "callback-1",
      data: "vw:fast:off",
      message: {
        message_id: 44,
        chat: { id: 123 }
      }
    }
  });
  assert.equal(settings.panic_mode, "false");
  assert.equal(editedMessages.length, 1);
  assert.match(editedMessages[0].text, /Control Panel/);
  assert.equal(answeredCallbacks[0].id, "callback-1");

  await control.handleUpdate({
    update_id: 14,
    callback_query: {
      id: "callback-2",
      data: "vw:status",
      message: {
        message_id: 44,
        chat: { id: 123 }
      }
    }
  });
  assert.equal(editedMessages.length, 2);
  assert.match(editedMessages[1].text, /Vine Watcher status/);
  assert.ok(editedMessages[1].options.reply_markup.inline_keyboard.length > 0);

  const sentBeforeUnchangedEdit = sentMessages.length;
  const editedBeforeUnchangedEdit = editedMessages.length;
  fakeTelegram.editText = async () => {
    throw new Error(
      "Telegram editMessageText failed: Bad Request: message is not modified: " +
        "specified new message content and reply markup are exactly the same"
    );
  };
  await control.handleUpdate({
    update_id: 15,
    callback_query: {
      id: "callback-3",
      data: "vw:menu",
      message: {
        message_id: 44,
        chat: { id: 123 }
      }
    }
  });
  assert.equal(sentMessages.length, sentBeforeUnchangedEdit);
  assert.equal(editedMessages.length, editedBeforeUnchangedEdit);
  assert.equal(answeredCallbacks[2].id, "callback-3");
}

function testTelegramFormatting() {
  const telegram = new TelegramClient(
    {
      telegramBotToken: "123456:test",
      telegramChatId: "123456789"
    },
    silentLogger
  );

  const message = telegram.formatProductMessage(
    {
      asin: "B002KTID3A",
      title: "Bosch drill bit set",
      section: "Recommended for you",
      section_url: "https://www.amazon.it/vine/vine-items?queue=potluck",
      url: "https://www.amazon.it/dp/B002KTID3A",
      estimated_value_eur: 42.5
    },
    {
      score: 25,
      positiveSignals: 3,
      negativeSignals: 0,
      reasons: ["brand: bosch"],
      notificationTriggers: ["estimated value \u20ac42.50 >= \u20ac35.00"]
    }
  );

  assert.match(message, /🚨 <b>Vine match<\/b> · Recommended for you/);
  assert.match(message, /Bosch drill bit set/);
  assert.match(message, /💰 <b>Value<\/b>: \u20ac42\.50/);
  assert.match(message, /🎯 <b>Score<\/b>: 25 · <b>Signals<\/b>: \+3 \/ -0/);
  assert.match(message, /🏷️ <b>Brand<\/b>: bosch/);
  assert.match(message, /🔔 <b>Trigger<\/b>: value \u20ac42\.50 &gt;= \u20ac35\.00/);
  assert.doesNotMatch(message, /https:\/\/www\.amazon\.it\/vine\/vine-items\?queue=potluck/);
  assert.doesNotMatch(message, /https:\/\/www\.amazon\.it\/dp\/B002KTID3A/);

  assert.deepEqual(telegram.productReplyMarkup({
    section_url: "https://www.amazon.it/vine/vine-items?queue=potluck",
    url: "https://www.amazon.it/dp/B002KTID3A"
  }), {
    inline_keyboard: [
      [
        {
          text: "Open Vine section",
          url: "https://www.amazon.it/vine/vine-items?queue=potluck"
        }
      ]
    ]
  });

  const noValueMessage = telegram.formatProductMessage(
    {
      asin: "B002KTID3A",
      title: "Bosch drill bit set",
      section: "Additional items",
      section_url: "https://www.amazon.it/vine/vine-items?queue=encore",
      estimated_value_eur: null
    },
    {
      score: 12,
      positiveSignals: 1,
      negativeSignals: 0,
      reasons: [],
      notificationTriggers: []
    }
  );

  assert.match(noValueMessage, /💰 <b>Value<\/b>: not shown/);

  const sessionMessage = telegram.formatSessionAttentionMessage(
    new Error('Amazon session is not valid or login is required for "Recommended for you".'),
    {
      failureCount: 2,
      maxFailures: 2,
      willStop: true
    }
  );

  assert.match(sessionMessage, /Amazon login required/);
  assert.match(sessionMessage, /Session health: 2\/2 consecutive failures/);
  assert.match(sessionMessage, /Watcher is stopping/);
  assert.match(sessionMessage, /server-login\.sh start/);
}

function testSessionStatusClassification() {
  assert.equal(
    classifySessionStatus({
      url: "https://www.amazon.it/vine/vine-items?queue=potluck",
      title: "Amazon Vine",
      signInText: true,
      hasVineText: true,
      hasVineCard: false,
      hasVineUrl: true
    }).needsAttention,
    false
  );

  const login = classifySessionStatus({
    url: "https://www.amazon.it/ap/signin",
    title: "Amazon Sign-In",
    emailInput: true,
    signInForm: true
  });
  assert.equal(login.needsAttention, true);
  assert.equal(login.kind, "login");

  const suspected = classifySessionStatus({
    url: "https://www.amazon.it/vine/vine-items?queue=potluck",
    title: "Accedi",
    signInText: true,
    hasVineText: false,
    hasVineCard: false,
    hasVineUrl: true
  });
  assert.equal(suspected.needsAttention, true);
  assert.equal(suspected.kind, "suspected-login");
  assert.equal(suspected.confirmable, true);

  const captcha = classifySessionStatus({
    url: "https://www.amazon.it/errors/validateCaptcha",
    title: "Robot Check",
    captchaInput: true
  });
  assert.equal(captcha.needsAttention, true);
  assert.equal(captcha.kind, "captcha");
  assert.equal(captcha.confirmable, false);
}

function testSessionAttentionDeferral() {
  const config = loadConfig({
    sessionAttentionGraceMs: 300000,
    sessionFailureBackoffMs: 90000
  });
  const now = Date.parse("2026-06-17T19:42:30Z");

  assert.equal(
    shouldDeferSessionAttention(
      { kind: "login", confirmable: true },
      config,
      now - 30000,
      now
    ),
    true
  );

  assert.equal(
    shouldDeferSessionAttention(
      { kind: "login", confirmable: true },
      config,
      now - 600000,
      now
    ),
    false
  );

  assert.equal(
    shouldDeferSessionAttention(
      { kind: "captcha", confirmable: false },
      config,
      now - 30000,
      now
    ),
    false
  );
}

function testTransientScanErrorClassification() {
  assert.equal(isTransientScanError(new Error("page.goto: Timeout 20000ms exceeded")), true);
  assert.equal(isTransientScanError(new Error("page.goto: net::ERR_FAILED at https://www.amazon.it/vine")), true);
  assert.equal(isTransientScanError(new Error('Section "Recommended for you" exceeded hard timeout after 30000ms')), true);
  assert.equal(isTransientScanError(new Error("Amazon session is not valid or login is required")), false);
  assert.equal(isTransientScanError(new Error("Telegram sendMessage failed")), false);
}

async function testRunCycleNotifiesAfterEachSection() {
  const events = [];
  const config = loadConfig({
    sections: [
      { name: "First", url: "https://www.amazon.it/vine/vine-items?queue=potluck" },
      { name: "Second", url: "https://www.amazon.it/vine/vine-items?queue=encore" }
    ],
    notifyAllProducts: true,
    maxNotificationsPerCycle: 5,
    sectionDelayMs: 0
  });
  const product = {
    id: 1,
    asin: "B002KTID3A",
    title: "Low score product",
    section: "First",
    section_url: "https://www.amazon.it/vine/vine-items?queue=potluck",
    estimated_value_eur: null
  };
  const scanner = {
    async scanSection(section) {
      events.push(`scan:${section.name}`);
      return section.name === "First" ? [product] : [];
    }
  };
  const storage = {
    findExisting() {
      return null;
    },
    saveProduct(savedProduct) {
      events.push(`save:${savedProduct.title}`);
      return {
        isNew: true,
        product: {
          ...savedProduct,
          id: 1,
          notified: 0
        }
      };
    },
    markNotified(productId) {
      events.push(`mark:${productId}`);
    },
    markMissingProducts() {
      events.push("missing:0");
      return 0;
    }
  };
  const telegram = {
    async sendProduct(sentProduct) {
      events.push(`notify:${sentProduct.id}`);
      return true;
    }
  };

  const summary = await runCycle({
    scanner,
    storage,
    telegram,
    config,
    logger: silentLogger
  });

  assert.deepEqual(events, [
    "scan:First",
    "save:Low score product",
    "notify:1",
    "mark:1",
    "save:Low score product",
    "scan:Second",
    "missing:0"
  ]);
  assert.deepEqual(
    {
      scanned: summary.scanned,
      newProducts: summary.newProducts,
      notified: summary.notified,
      maxScore: summary.maxScore
    },
    {
      scanned: 1,
      newProducts: 1,
      notified: 1,
      maxScore: 0
    }
  );
}

async function testRunCycleParallelProcessesFirstCompletedSection() {
  const events = [];
  const config = loadConfig({
    sections: [
      { name: "Slow RFY", url: "https://www.amazon.it/vine/vine-items?queue=potluck" },
      { name: "Fast AI", url: "https://www.amazon.it/vine/vine-items?queue=encore" }
    ],
    notifyAllProducts: true,
    maxNotificationsPerCycle: 5,
    sectionDelayMs: 0,
    sectionScanConcurrency: 2
  });
  const product = {
    id: 2,
    asin: "B0FASTVINE",
    title: "Fast section product",
    section: "Fast AI",
    section_url: "https://www.amazon.it/vine/vine-items?queue=encore",
    estimated_value_eur: null
  };
  const scanner = {
    async scanSection(section) {
      events.push(`scan:${section.name}`);
      if (section.name === "Slow RFY") {
        await new Promise((resolve) => setTimeout(resolve, 40));
        events.push(`done:${section.name}`);
        return [];
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`done:${section.name}`);
      return [product];
    }
  };
  const storage = {
    findExisting() {
      return null;
    },
    saveProduct(savedProduct) {
      events.push(`save:${savedProduct.title}`);
      return {
        isNew: true,
        product: {
          ...savedProduct,
          id: 2,
          notified: 0
        }
      };
    },
    markNotified(productId) {
      events.push(`mark:${productId}`);
    },
    markMissingProducts() {
      events.push("missing:0");
      return 0;
    }
  };
  const telegram = {
    async sendProduct(sentProduct) {
      events.push(`notify:${sentProduct.id}`);
      return true;
    }
  };

  const summary = await runCycle({
    scanner,
    storage,
    telegram,
    config,
    logger: silentLogger
  });

  assert.ok(events.indexOf("notify:2") < events.indexOf("done:Slow RFY"));
  assert.equal(summary.scanned, 1);
  assert.equal(summary.notified, 1);
}

async function testRunCycleContinuesAfterSectionFailure() {
  const events = [];
  const config = loadConfig({
    sections: [
      { name: "Recommended for you", url: "https://www.amazon.it/vine/vine-items?queue=potluck" },
      { name: "Additional items", url: "https://www.amazon.it/vine/vine-items?queue=encore" }
    ],
    notifyAllProducts: true,
    maxNotificationsPerCycle: 5,
    sectionDelayMs: 0
  });
  const product = {
    id: 3,
    asin: "B0PARTIAL",
    title: "Partial cycle product",
    section: "Additional items",
    section_url: "https://www.amazon.it/vine/vine-items?queue=encore",
    estimated_value_eur: null
  };
  const scanner = {
    async scanSection(section) {
      events.push(`scan:${section.name}`);
      if (section.name === "Recommended for you") {
        throw new Error("page.goto: Timeout 20000ms exceeded");
      }
      return [product];
    }
  };
  const storage = {
    findExisting() {
      return null;
    },
    saveProduct(savedProduct) {
      events.push(`save:${savedProduct.title}`);
      return {
        isNew: true,
        product: {
          ...savedProduct,
          id: 3,
          notified: 0
        }
      };
    },
    markNotified(productId) {
      events.push(`mark:${productId}`);
    },
    markMissingProducts(_inventoryAt, sectionNames) {
      events.push(`missing:${(sectionNames || []).join("|")}`);
      return 0;
    }
  };
  const telegram = {
    async sendProduct(sentProduct) {
      events.push(`notify:${sentProduct.id}`);
      return true;
    }
  };

  const summary = await runCycle({
    scanner,
    storage,
    telegram,
    config,
    logger: silentLogger
  });

  assert.deepEqual(events, [
    "scan:Recommended for you",
    "scan:Additional items",
    "save:Partial cycle product",
    "notify:3",
    "mark:3",
    "save:Partial cycle product",
    "missing:Additional items"
  ]);
  assert.equal(summary.scanned, 1);
  assert.equal(summary.newProducts, 1);
  assert.equal(summary.notified, 1);
  assert.equal(summary.outcome, "sent_notifications");
  assert.equal(summary.sectionFailures.length, 1);
  assert.equal(summary.sectionFailures[0].section, "Recommended for you");
  assert.match(summary.layoutWarnings.join("\n"), /section failure/);
}

async function testRunCycleUsesDetailValueBeforeMinValueTrigger() {
  const events = [];
  const saves = [];
  const sentProducts = [];
  const config = loadConfig({
    sections: [
      { name: "Additional items", url: "https://www.amazon.it/vine/vine-items?queue=encore" }
    ],
    notifyAllProducts: false,
    notifyAllProductsWindow: "",
    minScoreToNotify: 99,
    minValueToNotifyEur: 35,
    strictNotifyMode: true,
    strictMinPositiveSignals: 2,
    strictMaxNegativeSignals: 0,
    maxNotificationsPerCycle: 5,
    detailValueLookupEnabled: true,
    detailValueLookupMaxPerCycle: 5,
    sectionDelayMs: 0
  });
  const product = {
    asin: "B0VALUEONLY",
    title: "Plain low score product",
    section: "Additional items",
    section_url: "https://www.amazon.it/vine/vine-items?queue=encore",
    estimated_value_eur: null,
    vine_recommendation_id: "APJ#B0VALUEONLY#vine.enrollment.test",
    raw_text: ""
  };
  const scanner = {
    async scanSection(section) {
      events.push(`scan:${section.name}`);
      return [product];
    },
    async enrichProductValue(valueProduct) {
      events.push(`enrich:${valueProduct.asin}`);
      return {
        ...valueProduct,
        estimated_value_eur: 42.5
      };
    }
  };
  const storage = {
    findExisting() {
      return null;
    },
    saveProduct(savedProduct, _scoring, diagnostics = {}) {
      saves.push({ product: savedProduct, diagnostics });
      events.push(`save:${diagnostics.decision}:${savedProduct.estimated_value_eur}`);
      return {
        isNew: saves.length === 1,
        product: {
          ...savedProduct,
          id: 42,
          notified: 0
        }
      };
    },
    markNotified(productId) {
      events.push(`mark:${productId}`);
    },
    markMissingProducts() {
      events.push("missing:0");
      return 0;
    }
  };
  const telegram = {
    async sendProduct(sentProduct) {
      sentProducts.push(sentProduct);
      events.push(`notify:${sentProduct.estimated_value_eur}`);
      return true;
    }
  };

  const summary = await runCycle({
    scanner,
    storage,
    telegram,
    config,
    logger: silentLogger
  });

  assert.deepEqual(events, [
    "scan:Additional items",
    "enrich:B0VALUEONLY",
    "save:candidate:42.5",
    "notify:42.5",
    "mark:42",
    "save:notified:42.5",
    "missing:0"
  ]);
  assert.equal(sentProducts[0].estimated_value_eur, 42.5);
  assert.deepEqual(saves[0].diagnostics.triggers, ["estimated value \u20ac42.50 >= \u20ac35.00"]);
  assert.equal(summary.notified, 1);
  assert.equal(summary.detailValueLookupHits, 1);
}

async function testRunCycleUpdatesNotificationAfterDetailValueLookup() {
  const events = [];
  const config = loadConfig({
    sections: [
      { name: "Additional items", url: "https://www.amazon.it/vine/vine-items?queue=encore" }
    ],
    notifyAllProducts: true,
    notifyAllProductsWindow: "",
    minScoreToNotify: 99,
    minValueToNotifyEur: 35,
    maxNotificationsPerCycle: 5,
    detailValueLookupEnabled: true,
    detailValueLookupMaxPerCycle: 5,
    sectionDelayMs: 0
  });
  const product = {
    asin: "B0FASTVALUE",
    title: "Notify all product",
    section: "Additional items",
    section_url: "https://www.amazon.it/vine/vine-items?queue=encore",
    estimated_value_eur: null,
    vine_recommendation_id: "APJ#B0FASTVALUE#vine.enrollment.test",
    raw_text: ""
  };
  const scanner = {
    async scanSection(section) {
      events.push(`scan:${section.name}`);
      return [product];
    },
    async enrichProductValue(valueProduct) {
      events.push(`enrich:${valueProduct.asin}`);
      return {
        ...valueProduct,
        estimated_value_eur: 42.5
      };
    }
  };
  const storage = {
    findExisting() {
      return null;
    },
    saveProduct(savedProduct, _scoring, diagnostics = {}) {
      events.push(`save:${diagnostics.decision}:${savedProduct.estimated_value_eur || "none"}`);
      return {
        isNew: events.filter((event) => event.startsWith("save:")).length === 1,
        product: {
          ...savedProduct,
          id: 43,
          notified: 0
        }
      };
    },
    markNotified(productId) {
      events.push(`mark:${productId}`);
    },
    markMissingProducts() {
      events.push("missing:0");
      return 0;
    }
  };
  const telegram = {
    async sendProduct(sentProduct) {
      events.push(`notify:${sentProduct.value_lookup_pending ? "pending" : sentProduct.estimated_value_eur || "none"}`);
      return {
        kind: "photo",
        chatId: 123,
        messageId: 456
      };
    },
    async editProductNotification(_sentMessage, editedProduct) {
      events.push(`edit:${editedProduct.estimated_value_eur}`);
      return true;
    }
  };

  const summary = await runCycle({
    scanner,
    storage,
    telegram,
    config,
    logger: silentLogger
  });

  assert.deepEqual(events, [
    "scan:Additional items",
    "save:candidate:none",
    "notify:pending",
    "mark:43",
    "enrich:B0FASTVALUE",
    "edit:42.5",
    "save:notified:42.5",
    "missing:0"
  ]);
  assert.equal(summary.notified, 1);
  assert.equal(summary.detailValueLookupHits, 1);
}

async function testRunCyclePersistsValuePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vine-watcher-value-pipeline-"));
  const storage = new ProductStorage(path.join(dir, "products.sqlite"), silentLogger);
  storage.init();
  const section = { name: "Additional items", url: "https://www.amazon.it/vine/vine-items?queue=encore" };
  const config = loadConfig({
    sections: [section],
    notifyAllProducts: true,
    notifyAllProductsWindow: "",
    maxNotificationsPerCycle: 5,
    detailValueLookupEnabled: true,
    detailValueLookupMaxPerCycle: 5,
    detailValueLookupRetryBaseMs: 5000,
    detailValueLookupRetryMaxMs: 60000,
    sectionDelayMs: 0
  });
  const product = {
    asin: "B0REALV001",
    title: "Real storage value product",
    normalized_title: "real storage value product",
    url: "https://www.amazon.it/dp/B0REALV001",
    section: section.name,
    section_url: section.url,
    estimated_value_eur: null,
    vine_recommendation_id: "APJ#B0REALV001#vine.enrollment.test",
    vine_card_asin: "B0REALV001",
    vine_recommendation_type: "SEARCH",
    raw_text: ""
  };
  const sentProducts = [];
  const editedProducts = [];
  const scanner = {
    config,
    async scanSection() {
      return [product];
    },
    async enrichProductValue(valueProduct) {
      return { ...valueProduct, estimated_value_eur: 64.99 };
    }
  };
  const telegram = {
    async sendProduct(sentProduct) {
      sentProducts.push(sentProduct);
      return { kind: "photo", chatId: 123, messageId: 456 };
    },
    async editProductNotification(sentMessage, editedProduct) {
      editedProducts.push({ sentMessage, editedProduct });
      return true;
    }
  };

  const summary = await runCycle({ scanner, storage, telegram, config, logger: silentLogger });
  const row = storage.searchProducts("real storage", 1)[0];
  assert.equal(summary.notified, 1);
  assert.equal(sentProducts[0].value_lookup_pending, true);
  assert.equal(editedProducts.length, 1);
  assert.equal(editedProducts[0].editedProduct.estimated_value_eur, 64.99);
  assert.equal(row.vine_recommendation_id, product.vine_recommendation_id);
  assert.equal(row.estimated_value_eur, 64.99);
  assert.equal(row.value_lookup_attempts, 1);
  assert.equal(row.value_lookup_status, "found");
  assert.equal(row.telegram_message_id, 456);

  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testRunCycleRetriesDeferredValueLookup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vine-watcher-value-retry-"));
  const storage = new ProductStorage(path.join(dir, "products.sqlite"), silentLogger);
  storage.init();
  const section = { name: "Additional items", url: "https://www.amazon.it/vine/vine-items?queue=encore" };
  const config = loadConfig({
    sections: [section],
    notifyAllProducts: false,
    notifyAllProductsWindow: "",
    minScoreToNotify: 999,
    minValueToNotifyEur: 35,
    maxNotificationsPerCycle: 5,
    detailValueLookupEnabled: true,
    detailValueLookupMaxPerCycle: 1,
    detailValueLookupRetryBaseMs: 5000,
    detailValueLookupRetryMaxMs: 60000,
    sectionDelayMs: 0
  });
  const product = {
    asin: "B0RETRY001",
    title: "Deferred value lookup product",
    normalized_title: "deferred value lookup product",
    url: "https://www.amazon.it/dp/B0RETRY001",
    section: section.name,
    section_url: section.url,
    estimated_value_eur: null,
    vine_recommendation_id: "APJ#B0RETRY001#vine.enrollment.test",
    raw_text: ""
  };
  let lookupCalls = 0;
  let notifications = 0;
  const scanner = {
    config,
    async scanSection() {
      return [product];
    },
    async enrichProductValue(valueProduct) {
      lookupCalls += 1;
      return lookupCalls === 1 ? valueProduct : { ...valueProduct, estimated_value_eur: 55 };
    }
  };
  const telegram = {
    async sendProduct() {
      notifications += 1;
      return { kind: "message", chatId: 123, messageId: 789 };
    }
  };

  const first = await runCycle({ scanner, storage, telegram, config, logger: silentLogger });
  assert.equal(first.notified, 0);
  const firstRow = storage.searchProducts("deferred value", 1)[0];
  assert.equal(firstRow.value_lookup_attempts, 1);
  storage.db
    .prepare("UPDATE products SET value_lookup_next_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", firstRow.id);

  const second = await runCycle({ scanner, storage, telegram, config, logger: silentLogger });
  const secondRow = storage.searchProducts("deferred value", 1)[0];
  assert.equal(second.notified, 1);
  assert.equal(notifications, 1);
  assert.equal(lookupCalls, 2);
  assert.equal(secondRow.estimated_value_eur, 55);
  assert.equal(secondRow.value_lookup_attempts, 2);

  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testParallelSessionFailureCancelsOtherScans() {
  const sections = [
    { name: "Session failure", url: "https://www.amazon.it/vine/vine-items?queue=potluck" },
    { name: "Slow section", url: "https://www.amazon.it/vine/vine-items?queue=encore" }
  ];
  const config = loadConfig({ sections, sectionScanConcurrency: 2, sectionDelayMs: 0 });
  let releaseSlow = null;
  let cancelled = false;
  let slowSettled = false;
  const scanner = {
    config,
    async scanSection(section) {
      if (section.name === "Session failure") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new SessionNeedsAttentionError("login required", { kind: "login" });
      }
      return new Promise((resolve) => {
        releaseSlow = () => {
          slowSettled = true;
          resolve([]);
        };
      });
    },
    async cancelActiveScans() {
      cancelled = true;
      releaseSlow();
    }
  };

  await assert.rejects(
    runCycle({ scanner, storage: {}, telegram: {}, config, logger: silentLogger }),
    SessionNeedsAttentionError
  );
  assert.equal(cancelled, true);
  assert.equal(slowSettled, true);
}

async function testTelegramRetriesTransientFailures() {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 500,
        statusText: "Server Error",
        async json() {
          return { ok: false, description: "temporary" };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return { ok: true, result: { message_id: 1 } };
      }
    };
  };

  try {
    const telegram = new TelegramClient(
      loadConfig({ telegramBotToken: "123456:test-token", telegramChatId: "123", telegramRequestRetries: 1 }),
      silentLogger
    );
    const result = await telegram.request("sendMessage", { chat_id: "123", text: "test" });
    assert.equal(result.message_id, 1);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testHealthServerFreshnessAndAuth() {
  const status = {
    startedAt: Date.now(),
    lastSuccessfulCycleAt: Date.now(),
    lastCycle: { success: true, scanned: 2, newProducts: 1, notified: 0 }
  };
  const storage = {
    getStats() {
      return { totals: { total: 2 }, scanCycles: { total: 1, failed: 0 } };
    },
    recentScanCycles() {
      return [];
    },
    recentProducts() {
      return [];
    }
  };
  const server = startHealthServer({
    config: {
      healthServerEnabled: true,
      healthServerHost: "127.0.0.1",
      healthServerPort: 0,
      healthServerToken: "health-token",
      healthStaleAfterMs: 30000
    },
    storage,
    getStatus: () => status,
    logger: silentLogger,
    version: "test"
  });
  await once(server, "listening");
  const port = server.address().port;

  async function request(headers = {}) {
    return new Promise((resolve, reject) => {
      const call = http.get({ host: "127.0.0.1", port, path: "/health", headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ statusCode: response.statusCode, body: JSON.parse(body) }));
      });
      call.on("error", reject);
    });
  }

  const unauthorized = await request();
  assert.equal(unauthorized.statusCode, 401);
  const healthy = await request({ Authorization: "Bearer health-token" });
  assert.equal(healthy.statusCode, 200);
  assert.equal(healthy.body.ok, true);

  status.lastSuccessfulCycleAt = Date.now() - 60000;
  const stale = await request({ Authorization: "Bearer health-token" });
  assert.equal(stale.statusCode, 503);
  assert.equal(stale.body.ok, false);

  await new Promise((resolve) => server.close(resolve));
}

function testScannerTurboOnlyDuringAdaptiveActive() {
  const config = loadConfig({
    adaptiveScanEnabled: true,
    scannerTurboOnlyDuringAdaptiveActive: true,
    sectionScanConcurrency: 2,
    reuseSectionPages: true
  });

  const idle = scannerConfigForCycle(config, {
    activeCyclesRemaining: 0
  });
  assert.equal(idle.adaptiveActive, false);
  assert.equal(idle.turboEnabled, false);
  assert.equal(idle.config.sectionScanConcurrency, 1);
  assert.equal(idle.config.reuseSectionPages, false);

  const active = scannerConfigForCycle(config, {
    activeCyclesRemaining: 3
  });
  assert.equal(active.adaptiveActive, true);
  assert.equal(active.turboEnabled, true);
  assert.equal(active.config.sectionScanConcurrency, 2);
  assert.equal(active.config.reuseSectionPages, true);
}

async function testScannerHardTimeoutClosesStuckPage() {
  let closed = 0;
  const section = {
    name: "Additional items",
    url: "https://www.amazon.it/vine/vine-items?queue=encore"
  };
  const page = {
    closed: false,
    isClosed() {
      return this.closed;
    },
    async goto() {
      return new Promise(() => {});
    },
    async close() {
      this.closed = true;
      closed += 1;
    }
  };

  const scanner = new VineScanner({
    context: {
      async newPage() {
        return page;
      }
    },
    config: loadConfig({
      reuseSectionPages: false,
      sectionHardTimeoutMs: 20,
      pageTimeoutMs: 1000
    }),
    logger: silentLogger
  });

  assert.equal(sectionHardTimeoutMs({ pageTimeoutMs: 10000, sectionHardTimeoutMs: 0 }), 15000);
  assert.equal(sectionHardTimeoutMs({ pageTimeoutMs: 10000, sectionHardTimeoutMs: 7000 }), 7000);
  await assert.rejects(() => scanner.scanSection(section), /hard timeout/);
  assert.equal(closed, 1);
}

async function testScannerReusesSectionPages() {
  let created = 0;
  let closed = 0;
  const section = {
    name: "Additional items",
    url: "https://www.amazon.it/vine/vine-items?queue=encore"
  };
  function makePage() {
    return {
      closed: false,
      isClosed() {
        return this.closed;
      },
      async goto() {
        return null;
      },
      async waitForLoadState() {},
      async waitForTimeout() {},
      async waitForFunction() {},
      async evaluate() {
        return [
          {
            asin: "B002KTID3A",
            title: "Bosch drill bit set",
            url: "/dp/B002KTID3A",
            raw_text: "Bosch drill bit set"
          }
        ];
      },
      async close() {
        this.closed = true;
        closed += 1;
      }
    };
  }

  const scanner = new VineScanner({
    context: {
      async newPage() {
        created += 1;
        return makePage();
      }
    },
    config: loadConfig({
      reuseSectionPages: true,
      waitForNetworkIdle: false,
      pageSettleMs: 0,
      pageTimeoutMs: 1000,
      productReadyTimeoutMs: 1000
    }),
    logger: silentLogger
  });
  scanner.assertSessionReady = async () => {};

  assert.equal((await scanner.scanSection(section)).length, 1);
  assert.equal((await scanner.scanSection(section)).length, 1);
  assert.equal(created, 1);
  await scanner.close();
  assert.equal(closed, 1);
}

async function main() {
  testEuroParsing();
  testUrlCanonicalization();
  testScoringAndTriggers();
  testNotifyAllProductWindow();
  testRuntimeSettings();
  testConfigValidation();
  testExternalScoringRules();
  testScannerFixtures();
  await testScannerDetailValueLookup();
  await testScannerRejectsHttpFailureAndRetries();
  testMemoryRecycleThresholdUsesGrowth();
  testStorageEstimatedValue();
  await testTelegramControlCommands();
  testTelegramFormatting();
  testSessionStatusClassification();
  testSessionAttentionDeferral();
  testTransientScanErrorClassification();
  await testRunCycleNotifiesAfterEachSection();
  await testRunCycleParallelProcessesFirstCompletedSection();
  await testRunCycleContinuesAfterSectionFailure();
  await testRunCycleUsesDetailValueBeforeMinValueTrigger();
  await testRunCycleUpdatesNotificationAfterDetailValueLookup();
  await testRunCyclePersistsValuePipeline();
  await testRunCycleRetriesDeferredValueLookup();
  await testParallelSessionFailureCancelsOtherScans();
  await testTelegramRetriesTransientFailures();
  await testHealthServerFreshnessAndAuth();
  testScannerTurboOnlyDuringAdaptiveActive();
  await testScannerHardTimeoutClosesStuckPage();
  await testScannerReusesSectionPages();
  console.log("Core tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
