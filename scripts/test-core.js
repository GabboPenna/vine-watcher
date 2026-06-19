"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../src/config");
const {
  isNotifyAllProductsActive,
  isTimeWindowActive,
  notificationTriggers,
  runCycle,
  shouldDeferSessionAttention
} = require("../src/index");
const { classifySessionStatus } = require("../src/scanner");
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
    raw_text: "42,50\u20ac"
  };

  storage.saveProduct(product, { score: 25, reasons: ["brand: bosch"] });
  assert.equal(
    storage.db.prepare("select estimated_value_eur from products where asin = ?").get(product.asin).estimated_value_eur,
    42.5
  );

  storage.saveProduct({ ...product, estimated_value_eur: null, raw_text: "" }, { score: 25, reasons: [] });
  assert.equal(
    storage.db.prepare("select estimated_value_eur from products where asin = ?").get(product.asin).estimated_value_eur,
    null
  );

  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
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

  assert.match(message, /Estimated value: \u20ac42\.50/);
  assert.match(message, /Open Vine section:\nhttps:\/\/www\.amazon\.it\/vine\/vine-items\?queue=potluck/);
  assert.doesNotMatch(message, /Open Vine section:\nhttps:\/\/www\.amazon\.it\/dp\/B002KTID3A/);

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
    }
  };
  const telegram = {
    async sendProduct(sentProduct) {
      events.push(`notify:${sentProduct.id}`);
      return true;
    }
  };

  await runCycle({
    scanner,
    storage,
    telegram,
    config,
    logger: silentLogger
  });

  assert.deepEqual(events, ["scan:First", "save:Low score product", "notify:1", "mark:1", "scan:Second"]);
}

async function main() {
  testEuroParsing();
  testUrlCanonicalization();
  testScoringAndTriggers();
  testNotifyAllProductWindow();
  testStorageEstimatedValue();
  testTelegramFormatting();
  testSessionStatusClassification();
  testSessionAttentionDeferral();
  await testRunCycleNotifiesAfterEachSection();
  console.log("Core tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
