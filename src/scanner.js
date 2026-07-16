"use strict";

const {
  canonicalizeAmazonUrl,
  canonicalizeUrl,
  extractAsinFromText,
  normalizeTitle,
  normalizeWhitespace,
  parseEuroValue,
  sleep,
  truncate,
  uniqueProducts
} = require("./utils");

class SessionNeedsAttentionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SessionNeedsAttentionError";
    this.details = details;
    this.kind = details.kind || "unknown";
    this.confirmable = details.confirmable !== false;
  }
}

class SectionScanTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SectionScanTimeoutError";
    this.details = details;
  }
}

class SectionPageInvalidError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SectionPageInvalidError";
    this.details = details;
  }
}

function isBrowserClosedError(error) {
  return /Target page, context or browser has been closed/i.test(error && error.message ? error.message : String(error));
}

function isRetryableSectionError(error) {
  if (error instanceof SectionScanTimeoutError || error instanceof SectionPageInvalidError) {
    return true;
  }
  const message = error && error.message ? error.message : String(error || "");
  return /page\.goto:.*Timeout|net::ERR_|exceeded hard timeout/i.test(message);
}

function sectionHardTimeoutMs(config) {
  if (config.sectionHardTimeoutMs && config.sectionHardTimeoutMs > 0) {
    return config.sectionHardTimeoutMs;
  }

  const pageTimeoutMs = Math.max(5000, Number(config.pageTimeoutMs) || 45000);
  return pageTimeoutMs + Math.max(5000, Math.ceil(pageTimeoutMs * 0.5));
}

function hasUsableEuroValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

async function closePageQuietly(page, timeoutMs = 3000) {
  if (!page || page.isClosed()) {
    return;
  }

  const closePromise = page.close().catch(() => {});
  await Promise.race([closePromise, sleep(timeoutMs)]);
}

function summarizeSessionStatus(status = {}) {
  const flags = [];
  for (const key of [
    "passwordInput",
    "emailInput",
    "signInForm",
    "captchaInput",
    "captchaText",
    "signInText",
    "hasVineCard",
    "hasVineText",
    "hasVineUrl"
  ]) {
    if (status[key]) {
      flags.push(key);
    }
  }

  let path = "unknown";
  try {
    const parsed = new URL(String(status.url || ""));
    path = parsed.pathname || "/";
  } catch (_error) {
    path = "unknown";
  }

  return `url_path=${path} title="${truncate(status.title || "", 80)}" flags=${flags.join(",") || "none"}`;
}

function classifySessionStatus(status, sectionName = "Vine") {
  const url = String(status.url || "").toLowerCase();
  const title = String(status.title || "").toLowerCase();
  const hasVineSignal = Boolean(status.hasVineCard || status.hasVineText);
  const loginUrl = /\/ap\/(signin|mfa|cvf|challenge|cq)/i.test(url);
  const signInPageTitle =
    /\bsign\s*in\b/i.test(title) ||
    /\blogin\b/i.test(title) ||
    /\baccedi\b/i.test(title) ||
    /\bidentificati\b/i.test(title);
  const blockingLoginUi = Boolean(status.passwordInput || status.emailInput || status.signInForm || loginUrl);

  if (status.captchaInput || status.captchaText) {
    return {
      needsAttention: true,
      kind: "captcha",
      confirmable: false,
      message: `Amazon requires a CAPTCHA or manual verification for "${sectionName}". Run npm run login and complete it manually.`
    };
  }

  if (blockingLoginUi) {
    return {
      needsAttention: true,
      kind: "login",
      confirmable: true,
      message: `Amazon session is not valid or login is required for "${sectionName}". Run npm run login.`
    };
  }

  if (!hasVineSignal && (status.signInText || signInPageTitle)) {
    return {
      needsAttention: true,
      kind: "suspected-login",
      confirmable: true,
      message:
        `Amazon may be asking for login for "${sectionName}", but no blocking login form was detected. ` +
        "A session health check will confirm it before stopping."
    };
  }

  if (status.signInText || signInPageTitle) {
    return {
      needsAttention: false,
      kind: "soft-sign-in-text",
      warning:
        `The "${sectionName}" page contains generic sign-in text, but still looks like Vine; continuing.`
    };
  }

  return {
    needsAttention: false,
    kind: "ok"
  };
}

class VineScanner {
  constructor({ context, config, logger }) {
    this.context = context;
    this.config = config;
    this.logger = logger;
    this.sectionPages = new Map();
    this.activeScanPages = new Set();
  }

  async scanAllSections() {
    const allProducts = [];
    for (const section of this.config.sections) {
      const products = await this.scanSection(section);
      allProducts.push(...products);
      if (this.config.sectionDelayMs > 0) {
        await sleep(this.config.sectionDelayMs);
      }
    }
    return uniqueProducts(allProducts);
  }

  async scanSection(section) {
    const retries = Math.max(0, Math.floor(Number(this.config.sectionNavigationRetries || 0)));
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.scanSectionAttempt(section);
      } catch (error) {
        lastError = error;
        if (
          error instanceof SessionNeedsAttentionError ||
          isBrowserClosedError(error) ||
          !isRetryableSectionError(error) ||
          attempt >= retries
        ) {
          throw error;
        }
        const delayMs = Math.max(0, Number(this.config.sectionNavigationRetryDelayMs || 0));
        this.logger.warn(
          `Retrying section "${section.name}" after transient failure ` +
            `(attempt ${attempt + 2}/${retries + 1}): ${error.message}`
        );
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    }
    throw lastError;
  }

  async scanSectionAttempt(section) {
    const reusePage = Boolean(this.config.reuseSectionPages);
    const page = await this.pageForSection(section, reusePage);
    this.activeScanPages.add(page);
    const hardTimeoutMs = sectionHardTimeoutMs(this.config);
    let watchdogTimer = null;
    let watchdogTriggered = false;

    const watchdog = new Promise((_, reject) => {
      watchdogTimer = setTimeout(() => {
        watchdogTriggered = true;
        const error = new SectionScanTimeoutError(
          `Section "${section.name}" exceeded hard timeout after ${hardTimeoutMs}ms`,
          {
            sectionName: section.name,
            sectionUrl: section.url,
            hardTimeoutMs
          }
        );
        this.logger.warn(`${error.message}; closing the page to avoid a stuck Chromium renderer`);
        closePageQuietly(page).catch(() => {});
        reject(error);
      }, hardTimeoutMs);
    });

    try {
      return await Promise.race([this.scanSectionWithPage(section, page), watchdog]);
    } catch (error) {
      if (reusePage) {
        await this.discardSectionPage(section, page);
      }
      if (error instanceof SessionNeedsAttentionError) {
        throw error;
      }
      if (!isBrowserClosedError(error)) {
        this.logger.error(`Scanner error on "${section.name}": ${error.message}`);
      }
      throw error;
    } finally {
      clearTimeout(watchdogTimer);
      this.activeScanPages.delete(page);
      if (!reusePage && !watchdogTriggered) {
        await closePageQuietly(page);
      }
    }
  }

  async scanSectionWithPage(section, page) {
    this.logger.info(`Scanning "${section.name}"`);
    const response = await page.goto(section.url, {
      waitUntil: "domcontentloaded",
      timeout: this.config.pageTimeoutMs
    });

    const httpStatus = response ? response.status() : 0;
    if (httpStatus === 429 || httpStatus >= 500) {
      throw new SectionPageInvalidError(`Amazon returned HTTP ${httpStatus} for "${section.name}"`, {
        sectionName: section.name,
        sectionUrl: section.url,
        httpStatus
      });
    }

    await this.waitForReadableDom(page, section);

    if (this.config.waitForNetworkIdle) {
      await page
        .waitForLoadState("networkidle", {
          timeout: Math.min(this.config.pageTimeoutMs, 15000)
        })
        .catch(() => {
          this.logger.debug(`Network did not become idle for "${section.name}"; continuing with DOM read`);
        });
    }

    if (this.config.pageSettleMs > 0) {
      await page.waitForTimeout(this.config.pageSettleMs);
    }

    await this.assertSessionReady(page, section);

    const rawProducts = await page.evaluate(extractProductsFromPage, {
      sectionName: section.name,
      sectionUrl: section.url
    });

    const products = rawProducts
      .map((product) => this.normalizeProduct(product, section))
      .filter((product) => product.title && (product.asin || product.url));

    const unique = uniqueProducts(products);
    if (unique.length === 0) {
      const inventoryStatus = await readInventoryStatus(page);
      const validEmptyInventory = inventoryStatus.hasInventoryStructure || inventoryStatus.hasExplicitEmptyState;
      if (inventoryStatus.hasAmazonErrorText || !validEmptyInventory || httpStatus === 401 || httpStatus === 403) {
        throw new SectionPageInvalidError(
          `The "${section.name}" page returned no products and no trustworthy empty inventory state`,
          {
            sectionName: section.name,
            sectionUrl: section.url,
            httpStatus,
            ...inventoryStatus
          }
        );
      }
      this.logger.info(`Section "${section.name}" contains a confirmed empty Vine inventory`);
    }
    this.logger.info(`Section "${section.name}" scanned: ${unique.length} product candidates`);
    return unique;
  }

  sectionPageKey(section) {
    return `${section.name}\n${section.url || ""}`;
  }

  async pageForSection(section, reusePage) {
    if (!reusePage) {
      return this.context.newPage();
    }

    const key = this.sectionPageKey(section);
    const existing = this.sectionPages.get(key);
    if (existing && !existing.isClosed()) {
      return existing;
    }

    const page = await this.context.newPage();
    this.sectionPages.set(key, page);
    return page;
  }

  async discardSectionPage(section, page) {
    const key = this.sectionPageKey(section);
    if (this.sectionPages.get(key) === page) {
      this.sectionPages.delete(key);
    }
    await closePageQuietly(page);
  }

  async close() {
    const pages = Array.from(this.sectionPages.values());
    this.sectionPages.clear();
    await Promise.all(pages.map((page) => closePageQuietly(page)));
  }

  async cancelActiveScans(reason = "cycle cancelled") {
    const pages = Array.from(this.activeScanPages);
    if (pages.length === 0) {
      return;
    }
    this.logger.warn(`Cancelling ${pages.length} active section scan(s): ${reason}`);
    for (const [key, page] of this.sectionPages.entries()) {
      if (this.activeScanPages.has(page)) {
        this.sectionPages.delete(key);
      }
    }
    await Promise.all(pages.map((page) => closePageQuietly(page)));
  }

  async waitForReadableDom(page, section) {
    await page
      .waitForFunction(
        () => {
          if (!document.body) {
            return false;
          }

          const hasVineCard = Boolean(
            document.querySelector(
              '[id^="vvp-item-tile"], .vvp-item-tile, .vvp-item-tile-content, .vvp-item-product-title'
            )
          );
          if (hasVineCard) {
            return true;
          }

          const text = (document.body.innerText || "").toLowerCase();
          const title = (document.title || "").toLowerCase();
          return (
            text.includes("vine") ||
            text.includes("captcha") ||
            text.includes("robot check") ||
            text.includes("accedi al tuo account") ||
            text.includes("identificati") ||
            title.includes("sign in") ||
            title.includes("accedi") ||
            Boolean(document.querySelector('input[type="password"], input#ap_password, input#captchacharacters'))
          );
        },
        null,
        {
          timeout: this.config.productReadyTimeoutMs
        }
      )
      .catch(() => {
        this.logger.debug(`Readable DOM wait timed out for "${section.name}"; continuing with current DOM`);
      });
  }

  normalizeProduct(rawProduct, section) {
    const rawText = normalizeWhitespace(rawProduct.raw_text || "");
    const title = normalizeWhitespace(rawProduct.title || rawProduct.image_alt || "");
    const url = canonicalizeAmazonUrl(rawProduct.url, section.url || this.config.amazonVineBaseUrl);
    const estimatedValueEur = parseEuroValue(
      [rawProduct.estimated_value_eur, rawProduct.raw_text, rawProduct.title, rawProduct.image_alt]
        .filter(Boolean)
        .join(" ")
    );
    const asin =
      normalizeWhitespace(rawProduct.asin || "") ||
      extractAsinFromText([url, rawProduct.asin_source, rawText].filter(Boolean).join(" "));

    return {
      asin,
      title,
      normalized_title: normalizeTitle(title),
      url,
      image_url: canonicalizeUrl(rawProduct.image_url, section.url || this.config.amazonVineBaseUrl),
      section: section.name,
      section_url: section.url || this.config.amazonVineBaseUrl,
      estimated_value_eur: estimatedValueEur,
      vine_recommendation_id: normalizeWhitespace(rawProduct.vine_recommendation_id || ""),
      vine_card_asin: normalizeWhitespace(rawProduct.vine_card_asin || ""),
      vine_recommendation_type: normalizeWhitespace(rawProduct.vine_recommendation_type || ""),
      raw_text: truncate(rawText, 4000)
    };
  }

  async enrichProductValue(product) {
    if (!this.config.detailValueLookupEnabled || !product || hasUsableEuroValue(product.estimated_value_eur)) {
      return product;
    }

    const recommendationId = normalizeWhitespace(product.vine_recommendation_id || "");
    if (!recommendationId || !this.context || !this.context.request) {
      return product;
    }

    const timeout = Math.max(1000, Number(this.config.detailValueLookupTimeoutMs) || 4000);
    const baseUrl = product.section_url || this.config.amazonVineBaseUrl || "https://www.amazon.it/vine/vine-items";
    let origin = "https://www.amazon.it";
    try {
      origin = new URL(baseUrl).origin;
    } catch (_error) {
      origin = "https://www.amazon.it";
    }

    const encodedRecommendationId = encodeURIComponent(recommendationId);
    const recommendationUrl = `${origin}/vine/api/recommendations/${encodedRecommendationId}`;
    const recommendation = await this.fetchVineJson(recommendationUrl, timeout);
    const result = recommendation && recommendation.result ? recommendation.result : {};
    const directItem = result.item && typeof result.item === "object" ? result.item : null;
    const itemAsin = this.pickDetailItemAsin(product, result, directItem);

    let item = directItem;
    if (!item && itemAsin) {
      const itemUrl = `${recommendationUrl}/item/${encodeURIComponent(itemAsin)}?imageSize=180`;
      const itemResponse = await this.fetchVineJson(itemUrl, timeout);
      item = itemResponse && itemResponse.result ? itemResponse.result : null;
    }

    if (!item) {
      return product;
    }

    const taxCurrency = normalizeWhitespace(item.taxCurrency || "EUR").toUpperCase();
    const taxValue = Number(item.taxValue);
    if (taxCurrency !== "EUR" || !Number.isFinite(taxValue) || taxValue <= 0) {
      return product;
    }

    return {
      ...product,
      image_url: product.image_url || canonicalizeUrl(item.imageUrl, baseUrl),
      estimated_value_eur: taxValue
    };
  }

  async fetchVineJson(url, timeout) {
    const response = await this.context.request.get(url, {
      timeout
    });
    try {
      const ok =
        typeof response.ok === "function" ? response.ok() : response.status() >= 200 && response.status() < 300;
      if (!ok) {
        throw new Error(`Vine detail lookup failed: HTTP ${response.status()}`);
      }
      return await response.json();
    } finally {
      if (typeof response.dispose === "function") {
        await response.dispose().catch(() => {});
      }
    }
  }

  pickDetailItemAsin(product, recommendationResult, directItem) {
    if (directItem && directItem.asin) {
      return normalizeWhitespace(directItem.asin);
    }

    const variations = Array.isArray(recommendationResult.variations) ? recommendationResult.variations : [];
    const productAsin = normalizeWhitespace(product.asin || "").toUpperCase();
    const matchingVariation = variations.find((variation) => {
      return normalizeWhitespace(variation && variation.asin).toUpperCase() === productAsin;
    });
    if (matchingVariation && matchingVariation.asin) {
      return normalizeWhitespace(matchingVariation.asin);
    }

    const firstVariation = variations.find((variation) => variation && variation.asin);
    return firstVariation ? normalizeWhitespace(firstVariation.asin) : productAsin;
  }

  async assertSessionReady(page, section) {
    const status = await readSessionStatus(page);
    const classification = classifySessionStatus(status, section.name);

    if (classification.needsAttention) {
      throw new SessionNeedsAttentionError(classification.message, {
        ...status,
        kind: classification.kind,
        confirmable: classification.confirmable
      });
    }

    if (classification.warning) {
      this.logger.warn(classification.warning);
    }

    if (!status.hasVineText) {
      this.logger.warn(`The "${section.name}" page does not look like a Vine page; trying selectors anyway`);
    }
  }

  async verifySessionHealth() {
    const page = await this.context.newPage();
    const section = {
      name: "session health",
      url: this.config.amazonVineBaseUrl
    };

    try {
      const response = await page.goto(section.url, {
        waitUntil: "domcontentloaded",
        timeout: this.config.pageTimeoutMs
      });

      if (response && response.status() >= 500) {
        this.logger.warn(`Amazon returned HTTP ${response.status()} during session health check`);
      }

      await this.waitForReadableDom(page, section);

      if (this.config.pageSettleMs > 0) {
        await page.waitForTimeout(Math.min(this.config.pageSettleMs, 1000));
      }

      const status = await readSessionStatus(page);
      const classification = classifySessionStatus(status, section.name);
      return {
        ok: !classification.needsAttention,
        status,
        classification
      };
    } finally {
      await closePageQuietly(page);
    }
  }
}

async function readSessionStatus(page) {
  return page.evaluate(() => {
    const text = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 6000);
    const lower = text.toLowerCase();
    const title = document.title || "";
    const titleLower = title.toLowerCase();
    const url = window.location.href;
    const passwordInput = Boolean(document.querySelector('input[type="password"], input#ap_password'));
    const emailInput = Boolean(document.querySelector('input[type="email"], input#ap_email, input[name="email"]'));
    const signInForm = Boolean(
      document.querySelector(
        'form[name="signIn"], form[action*="/ap/signin" i], form[action*="/ap/cvf" i], form[action*="/ap/mfa" i]'
      )
    );
    const captchaInput = Boolean(
      document.querySelector(
        'input[name*="captcha" i], input#captchacharacters, form[action*="validateCaptcha" i], img[src*="captcha" i]'
      )
    );
    const hasVineCard = Boolean(
      document.querySelector('[id^="vvp-item-tile"], .vvp-item-tile, .vvp-item-tile-content, .vvp-item-product-title')
    );
    const captchaText =
      lower.includes("captcha") ||
      lower.includes("robot check") ||
      lower.includes("inserisci i caratteri") ||
      lower.includes("verifica che non sei un robot");
    const signInText =
      titleLower.includes("sign in") ||
      titleLower.includes("accedi") ||
      lower.includes("accedi al tuo account") ||
      lower.includes("identificati") ||
      lower.includes("sign in to your account");

    return {
      url,
      title,
      passwordInput,
      emailInput,
      signInForm,
      captchaInput,
      captchaText,
      signInText,
      hasVineCard,
      hasVineText: lower.includes("vine"),
      hasVineUrl: url.includes("/vine/")
    };
  });
}

async function readInventoryStatus(page) {
  return page.evaluate(() => {
    const text = String((document.body && document.body.innerText) || "").toLowerCase();
    const hasInventoryStructure = Boolean(
      document.querySelector(
        [
          "#vvp-items-grid",
          "#vvp-items-grid-container",
          ".vvp-items-grid",
          ".vvp-items-grid-container",
          ".vvp-tab-content",
          '[data-testid*="vine" i]'
        ].join(",")
      )
    );
    const emptyPhrases = [
      "nessun prodotto",
      "non ci sono prodotti",
      "non ci sono articoli",
      "nessun articolo",
      "no products",
      "no items",
      "there are no items",
      "there are no products",
      "we do not have any offers",
      "non abbiamo offerte"
    ];
    return {
      hasInventoryStructure,
      hasExplicitEmptyState: emptyPhrases.some((phrase) => text.includes(phrase)),
      hasAmazonErrorText:
        text.includes("service unavailable") ||
        text.includes("sorry, something went wrong") ||
        text.includes("si e verificato un problema") ||
        text.includes("si è verificato un problema")
    };
  });
}

function extractProductsFromPage(args) {
  const productSelectors = [
    '[id^="vvp-item-tile"]',
    ".vvp-item-tile",
    ".vvp-item-tile-content",
    ".vvp-item-product-title",
    ".vvp-item-product-image"
  ];

  const cardSelector = [
    '[id^="vvp-item-tile"]',
    ".vvp-item-tile",
    ".vvp-item-tile-content"
  ].join(",");

  const ignoredContainerSelector = [
    "#navbar",
    "#nav-flyout-ewc",
    "#navFooter",
    "#rhf",
    ".ewc-item",
    ".ewc-item-content",
    ".ewc-item-actions",
    ".nav-flyout",
    ".sc-action-quantity",
    '[id^="sc-item"]',
    '[data-component-type="s-shopping-cart"]',
    "header",
    "footer"
  ].join(",");

  const titleSelectors = [
    ".vvp-item-product-title",
    ".a-truncate-full",
    ".a-size-base-plus",
    ".a-size-medium",
    ".a-link-normal .a-text-normal",
    'a[href*="/dp/"] span',
    'a[href*="/gp/product/"] span',
    'img[alt]'
  ];

  const ignoredLinePatterns = [
    /richiedi prodotto/i,
    /ordina/i,
    /invia/i,
    /mostra dettagli/i,
    /vedi dettagli/i,
    /seleziona/i,
    /^la quantita e'? 1$/i,
    /^la quantit\u00e0 \u00e8 1$/i,
    /^\d+([,.]\d+)?\s*\u20ac/,
    /^-?\d+%$/,
    /^consigl\./i,
    /^mediano:/i,
    /^pagina \d+/i,
    /^prime$/i,
    /^amazon vine$/i
  ];

  function textOf(node) {
    return String((node && (node.innerText || node.textContent)) || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function attr(node, name) {
    return node && node.getAttribute ? node.getAttribute(name) || "" : "";
  }

  function absoluteUrl(value) {
    if (!value) {
      return "";
    }
    try {
      return new URL(value, window.location.href).toString();
    } catch (_error) {
      return "";
    }
  }

  function collectCards() {
    const cards = new Set();
    for (const selector of productSelectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_error) {
        nodes = [];
      }

      for (const node of nodes) {
        const card = node.closest(cardSelector);
        if (card && isVineCard(card)) {
          cards.add(card);
        }
      }
    }
    return Array.from(cards);
  }

  function isVineCard(card) {
    if (!card || card.closest(ignoredContainerSelector) || !hasVisibleBox(card)) {
      return false;
    }

    return (
      card.matches('[id^="vvp-item-tile"], .vvp-item-tile, .vvp-item-tile-content') ||
      Boolean(card.querySelector(".vvp-item-product-title, .vvp-item-product-image"))
    );
  }

  function hasVisibleBox(node) {
    const rect = node.getBoundingClientRect();
    return rect.width > 20 && rect.height > 20;
  }

  function pickTitle(card) {
    for (const selector of titleSelectors) {
      const node = card.querySelector(selector);
      if (!node) {
        continue;
      }
      const fromAlt = node.tagName === "IMG" ? attr(node, "alt") : "";
      const value = (fromAlt || textOf(node)).trim();
      if (isLikelyTitle(value)) {
        return value;
      }
    }

    const image = card.querySelector("img[alt]");
    const imageAlt = attr(image, "alt");
    if (isLikelyTitle(imageAlt)) {
      return imageAlt;
    }

    const lines = String(card.innerText || card.textContent || "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(isLikelyTitle)
      .sort((a, b) => b.length - a.length);

    return lines[0] || "";
  }

  function isLikelyTitle(value) {
    const text = String(value || "").trim();
    if (text.length < 4 || text.length > 500) {
      return false;
    }
    return !ignoredLinePatterns.some((pattern) => pattern.test(text));
  }

  function pickUrl(card) {
    const anchors = Array.from(card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]'));
    for (const anchor of anchors) {
      const href = attr(anchor, "href");
      if (href && !href.includes("javascript:")) {
        return absoluteUrl(href);
      }
    }
    return "";
  }

  function pickImage(card) {
    const image = card.querySelector("img[src], img[data-src]");
    return absoluteUrl(attr(image, "src") || attr(image, "data-src"));
  }

  function pickAsin(card, url) {
    const detailInput = card.querySelector(".vvp-details-btn input[data-asin]");
    const ownAttrs = [
      attr(card, "data-asin"),
      attr(card, "data-itemid"),
      attr(card, "data-recommendation-asin"),
      attr(card, "id"),
      attr(detailInput, "data-asin"),
      url
    ];

    const withAsin = card.querySelector("[data-asin], [data-itemid]");
    if (withAsin) {
      ownAttrs.push(attr(withAsin, "data-asin"), attr(withAsin, "data-itemid"), attr(withAsin, "id"));
    }

    const joined = ownAttrs.filter(Boolean).join(" ");
    const patterns = [
      /(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i,
      /(?:data-asin|asin|vvp-item-tile)[=/: -]*([A-Z0-9]{10})/i,
      /\bB[0-9A-Z]{9}\b/i
    ];
    for (const pattern of patterns) {
      const match = joined.match(pattern);
      if (match) {
        return (match[1] || match[0]).toUpperCase();
      }
    }
    return "";
  }

  const products = [];
  for (const card of collectCards()) {
    const rawText = textOf(card);
    const title = pickTitle(card);
    const url = pickUrl(card);
    const image = pickImage(card);
    const asin = pickAsin(card, url);
    const detailInput = card.querySelector(".vvp-details-btn input[data-asin]");

    if (!title && !asin && !url) {
      continue;
    }

    products.push({
      asin,
      asin_source: [attr(card, "data-asin"), attr(card, "data-itemid"), attr(card, "id")].filter(Boolean).join(" "),
      title,
      url,
      image_url: image,
      image_alt: attr(card.querySelector("img[alt]"), "alt"),
      section: args.sectionName,
      section_url: args.sectionUrl,
      vine_recommendation_id: attr(detailInput, "data-recommendation-id"),
      vine_card_asin: attr(detailInput, "data-asin"),
      vine_recommendation_type: attr(detailInput, "data-recommendation-type"),
      raw_text: rawText
    });
  }

  return products;
}

module.exports = {
  classifySessionStatus,
  isBrowserClosedError,
  isRetryableSectionError,
  SectionPageInvalidError,
  SectionScanTimeoutError,
  SessionNeedsAttentionError,
  sectionHardTimeoutMs,
  summarizeSessionStatus,
  VineScanner
};
