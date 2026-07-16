"use strict";

const fs = require("fs");
const Database = require("better-sqlite3");
const {
  ensureDirForFile,
  escapeCsv,
  identityKey,
  normalizeTitle,
  nowIso,
  truncate
} = require("./utils");

function normalizeEstimatedValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonText(value, fallback = []) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch (_error) {
    return JSON.stringify(fallback);
  }
}

class ProductStorage {
  constructor(databasePath, logger) {
    this.databasePath = databasePath;
    this.logger = logger;
    this.db = null;
  }

  init() {
    ensureDirForFile(this.databasePath);
    this.db = new Database(this.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identity_key TEXT,
        asin TEXT,
        title TEXT NOT NULL,
        normalized_title TEXT,
        url TEXT,
        section_url TEXT,
        image_url TEXT,
        section TEXT,
        estimated_value_eur REAL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        reasons_json TEXT NOT NULL DEFAULT '[]',
        notified INTEGER NOT NULL DEFAULT 0,
        raw_text TEXT,
        present_now INTEGER NOT NULL DEFAULT 1,
        last_inventory_at TEXT,
        disappeared_at TEXT,
        reappeared_count INTEGER NOT NULL DEFAULT 0,
        last_notified_at TEXT,
        first_score INTEGER,
        first_reasons_json TEXT,
        last_triggers_json TEXT NOT NULL DEFAULT '[]',
        last_blockers_json TEXT NOT NULL DEFAULT '[]',
        last_config_json TEXT NOT NULL DEFAULT '{}',
        last_decision TEXT NOT NULL DEFAULT '',
        vine_recommendation_id TEXT,
        vine_card_asin TEXT,
        vine_recommendation_type TEXT,
        value_lookup_attempts INTEGER NOT NULL DEFAULT 0,
        value_lookup_last_at TEXT,
        value_lookup_next_at TEXT,
        value_lookup_status TEXT NOT NULL DEFAULT '',
        telegram_chat_id TEXT,
        telegram_message_id INTEGER,
        telegram_message_kind TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_products_asin ON products(asin);
      CREATE INDEX IF NOT EXISTS idx_products_url ON products(url);
      CREATE INDEX IF NOT EXISTS idx_products_normalized_title ON products(normalized_title);
      CREATE INDEX IF NOT EXISTS idx_products_score ON products(score);
      CREATE INDEX IF NOT EXISTS idx_products_notified ON products(notified);
      CREATE INDEX IF NOT EXISTS idx_products_last_seen_at ON products(last_seen_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scan_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        scanned INTEGER NOT NULL DEFAULT 0,
        new_products INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0,
        max_score INTEGER,
        duration_seconds REAL NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL DEFAULT '',
        reason_no_notifications TEXT NOT NULL DEFAULT '',
        sections_json TEXT NOT NULL DEFAULT '[]',
        layout_warnings_json TEXT NOT NULL DEFAULT '[]',
        success INTEGER NOT NULL DEFAULT 1,
        failure_kind TEXT NOT NULL DEFAULT '',
        error_text TEXT NOT NULL DEFAULT '',
        disappeared_products INTEGER NOT NULL DEFAULT 0,
        telegram_failures INTEGER NOT NULL DEFAULT 0,
        section_failures_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_scan_cycles_completed_at ON scan_cycles(completed_at);
      CREATE INDEX IF NOT EXISTS idx_scan_cycles_outcome ON scan_cycles(outcome);
    `);
    this.migrate();
    this.prepareStatements();
    this.logger.info(`SQLite ready at ${this.databasePath}`);
  }

  migrate() {
    const ensureColumn = (table, name, definition) => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      if (!columns.includes(name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };

    ensureColumn("products", "section_url", "TEXT");
    ensureColumn("products", "estimated_value_eur", "REAL");
    ensureColumn("products", "present_now", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn("products", "last_inventory_at", "TEXT");
    ensureColumn("products", "disappeared_at", "TEXT");
    ensureColumn("products", "reappeared_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("products", "last_notified_at", "TEXT");
    ensureColumn("products", "first_score", "INTEGER");
    ensureColumn("products", "first_reasons_json", "TEXT");
    ensureColumn("products", "last_triggers_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("products", "last_blockers_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("products", "last_config_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("products", "last_decision", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("products", "identity_key", "TEXT");
    ensureColumn("products", "vine_recommendation_id", "TEXT");
    ensureColumn("products", "vine_card_asin", "TEXT");
    ensureColumn("products", "vine_recommendation_type", "TEXT");
    ensureColumn("products", "value_lookup_attempts", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("products", "value_lookup_last_at", "TEXT");
    ensureColumn("products", "value_lookup_next_at", "TEXT");
    ensureColumn("products", "value_lookup_status", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("products", "telegram_chat_id", "TEXT");
    ensureColumn("products", "telegram_message_id", "INTEGER");
    ensureColumn("products", "telegram_message_kind", "TEXT");
    ensureColumn("scan_cycles", "layout_warnings_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("scan_cycles", "success", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn("scan_cycles", "failure_kind", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("scan_cycles", "error_text", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("scan_cycles", "disappeared_products", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("scan_cycles", "telegram_failures", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("scan_cycles", "section_failures_json", "TEXT NOT NULL DEFAULT '[]'");

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_products_identity_key ON products(identity_key);
      CREATE INDEX IF NOT EXISTS idx_products_present_now ON products(present_now);
      CREATE INDEX IF NOT EXISTS idx_products_disappeared_at ON products(disappeared_at);
      CREATE INDEX IF NOT EXISTS idx_products_recommendation_id ON products(vine_recommendation_id);
      CREATE INDEX IF NOT EXISTS idx_products_value_lookup_next ON products(value_lookup_next_at);
    `);

    this.db.exec(`
      UPDATE products
      SET identity_key = CASE
        WHEN COALESCE(asin, '') != '' THEN 'asin:' || upper(asin)
        WHEN COALESCE(vine_card_asin, '') != '' THEN 'asin:' || upper(vine_card_asin)
        WHEN COALESCE(vine_recommendation_id, '') != '' THEN 'recommendation:' || vine_recommendation_id
        WHEN COALESCE(url, '') != '' THEN 'url:' || url
        WHEN COALESCE(normalized_title, '') != '' THEN 'title:' || normalized_title
        ELSE NULL
      END
      WHERE COALESCE(identity_key, '') = ''
    `);
  }

  prepareStatements() {
    this.insertProduct = this.db.prepare(`
      INSERT INTO products (
        identity_key,
        asin,
        title,
        normalized_title,
        url,
        section_url,
        image_url,
        section,
        estimated_value_eur,
        first_seen_at,
        last_seen_at,
        score,
        reasons_json,
        notified,
        raw_text,
        present_now,
        last_inventory_at,
        disappeared_at,
        reappeared_count,
        first_score,
        first_reasons_json,
        last_triggers_json,
        last_blockers_json,
        last_config_json,
        last_decision,
        vine_recommendation_id,
        vine_card_asin,
        vine_recommendation_type
      ) VALUES (
        @identity_key,
        @asin,
        @title,
        @normalized_title,
        @url,
        @section_url,
        @image_url,
        @section,
        @estimated_value_eur,
        @now,
        @now,
        @score,
        @reasons_json,
        0,
        @raw_text,
        1,
        @inventory_at,
        NULL,
        0,
        @score,
        @reasons_json,
        @last_triggers_json,
        @last_blockers_json,
        @last_config_json,
        @last_decision,
        @vine_recommendation_id,
        @vine_card_asin,
        @vine_recommendation_type
      )
    `);

    this.updateProduct = this.db.prepare(`
      UPDATE products
      SET
        identity_key = COALESCE(NULLIF(@identity_key, ''), identity_key),
        asin = COALESCE(NULLIF(@asin, ''), asin),
        title = @title,
        normalized_title = COALESCE(NULLIF(@normalized_title, ''), normalized_title),
        url = COALESCE(NULLIF(@url, ''), url),
        section_url = COALESCE(NULLIF(@section_url, ''), section_url),
        image_url = COALESCE(NULLIF(@image_url, ''), image_url),
        section = @section,
        estimated_value_eur = COALESCE(@estimated_value_eur, estimated_value_eur),
        last_seen_at = @now,
        score = @score,
        reasons_json = @reasons_json,
        raw_text = @raw_text,
        present_now = 1,
        last_inventory_at = @inventory_at,
        disappeared_at = CASE WHEN present_now = 0 THEN NULL ELSE disappeared_at END,
        reappeared_count = CASE WHEN present_now = 0 THEN reappeared_count + 1 ELSE reappeared_count END,
        first_score = COALESCE(first_score, @score),
        first_reasons_json = COALESCE(first_reasons_json, @reasons_json),
        last_triggers_json = @last_triggers_json,
        last_blockers_json = @last_blockers_json,
        last_config_json = @last_config_json,
        last_decision = @last_decision,
        vine_recommendation_id = COALESCE(NULLIF(@vine_recommendation_id, ''), vine_recommendation_id),
        vine_card_asin = COALESCE(NULLIF(@vine_card_asin, ''), vine_card_asin),
        vine_recommendation_type = COALESCE(NULLIF(@vine_recommendation_type, ''), vine_recommendation_type)
      WHERE id = @id
    `);

    this.markNotifiedStatement = this.db.prepare(`
      UPDATE products
      SET notified = 1,
          last_notified_at = @now,
          telegram_chat_id = COALESCE(NULLIF(@telegram_chat_id, ''), telegram_chat_id),
          telegram_message_id = COALESCE(@telegram_message_id, telegram_message_id),
          telegram_message_kind = COALESCE(NULLIF(@telegram_message_kind, ''), telegram_message_kind)
      WHERE id = @id
    `);

    this.recordValueLookupStatement = this.db.prepare(`
      UPDATE products
      SET value_lookup_attempts = value_lookup_attempts + 1,
          value_lookup_last_at = @now,
          value_lookup_next_at = @next_at,
          value_lookup_status = @status
      WHERE id = @id
    `);

    this.findProductByIdStatement = this.db.prepare("SELECT * FROM products WHERE id = ?");

    this.getSettingsStatement = this.db.prepare("SELECT key, value FROM settings ORDER BY key");

    this.getSettingStatement = this.db.prepare("SELECT value FROM settings WHERE key = ?");

    this.setSettingStatement = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    this.deleteSettingStatement = this.db.prepare("DELETE FROM settings WHERE key = ?");

    this.insertScanCycleStatement = this.db.prepare(`
      INSERT INTO scan_cycles (
        started_at,
        completed_at,
        scanned,
        new_products,
        notified,
        max_score,
        duration_seconds,
        outcome,
        reason_no_notifications,
        sections_json,
        layout_warnings_json,
        success,
        failure_kind,
        error_text,
        disappeared_products,
        telegram_failures,
        section_failures_json
      ) VALUES (
        @started_at,
        @completed_at,
        @scanned,
        @new_products,
        @notified,
        @max_score,
        @duration_seconds,
        @outcome,
        @reason_no_notifications,
        @sections_json,
        @layout_warnings_json,
        @success,
        @failure_kind,
        @error_text,
        @disappeared_products,
        @telegram_failures,
        @section_failures_json
      )
    `);
  }

  findExisting(product) {
    const normalizedTitle = product.normalized_title || normalizeTitle(product.title);
    const asin = String(product.asin || product.vine_card_asin || "").trim().toUpperCase();
    const recommendationId = String(product.vine_recommendation_id || "").trim();
    const url = String(product.url || "").trim();
    const strongIdentity = Boolean(asin || recommendationId || url);
    const key = identityKey({ ...product, normalized_title: normalizedTitle });

    if (key && !key.startsWith("title:")) {
      const byIdentity = this.db
        .prepare("SELECT * FROM products WHERE identity_key = ? ORDER BY id ASC LIMIT 1")
        .get(key);
      if (byIdentity) {
        return byIdentity;
      }
    }

    if (asin) {
      const byAsin = this.db
        .prepare(
          `SELECT * FROM products
           WHERE upper(COALESCE(asin, '')) = @asin
              OR upper(COALESCE(vine_card_asin, '')) = @asin
           ORDER BY id ASC LIMIT 1`
        )
        .get({ asin });
      if (byAsin) {
        return byAsin;
      }
    }

    if (recommendationId) {
      const byRecommendation = this.db
        .prepare("SELECT * FROM products WHERE vine_recommendation_id = ? ORDER BY id ASC LIMIT 1")
        .get(recommendationId);
      if (byRecommendation) {
        return byRecommendation;
      }
    }

    if (url) {
      const byUrl = this.db.prepare("SELECT * FROM products WHERE url = ? ORDER BY id ASC LIMIT 1").get(url);
      if (byUrl) {
        return byUrl;
      }
    }

    if (strongIdentity || !normalizedTitle) {
      return null;
    }

    return this.db
      .prepare("SELECT * FROM products WHERE normalized_title = ? ORDER BY id ASC LIMIT 1")
      .get(normalizedTitle);
  }

  saveProduct(product, scoring, diagnostics = {}) {
    const now = nowIso();
    const normalizedTitle = product.normalized_title || normalizeTitle(product.title);
    const payload = {
      identity_key: identityKey({ ...product, normalized_title: normalizedTitle }),
      asin: String(product.asin || "").trim().toUpperCase(),
      title: truncate(product.title || "Untitled product", 1000),
      normalized_title: normalizedTitle,
      url: product.url || "",
      section_url: product.section_url || "",
      image_url: product.image_url || "",
      section: product.section || "",
      estimated_value_eur: normalizeEstimatedValue(product.estimated_value_eur),
      now,
      score: scoring.score,
      reasons_json: jsonText(scoring.reasons || []),
      raw_text: truncate(product.raw_text || "", 4000),
      inventory_at: diagnostics.inventoryAt || now,
      last_triggers_json: jsonText(diagnostics.triggers || []),
      last_blockers_json: jsonText(diagnostics.blockers || []),
      last_config_json: jsonText(diagnostics.configSnapshot || {}, {}),
      last_decision: String(diagnostics.decision || ""),
      vine_recommendation_id: String(product.vine_recommendation_id || "").trim(),
      vine_card_asin: String(product.vine_card_asin || "").trim().toUpperCase(),
      vine_recommendation_type: String(product.vine_recommendation_type || "").trim()
    };

    const existing = this.findExisting(payload);
    if (existing) {
      this.updateProduct.run({ ...payload, id: existing.id });
      return {
        isNew: false,
        product: this.findProductByIdStatement.get(existing.id)
      };
    }

    const info = this.insertProduct.run(payload);
    return {
      isNew: true,
      product: this.findProductByIdStatement.get(info.lastInsertRowid)
    };
  }

  markNotified(productId, sentMessage = {}) {
    this.markNotifiedStatement.run({
      id: productId,
      now: nowIso(),
      telegram_chat_id: sentMessage.chatId === undefined ? "" : String(sentMessage.chatId),
      telegram_message_id: Number.isInteger(Number(sentMessage.messageId)) ? Number(sentMessage.messageId) : null,
      telegram_message_kind: String(sentMessage.kind || "")
    });
    return this.findProductByIdStatement.get(productId);
  }

  recordValueLookupAttempt(productId, { found = false, nextAt = null, error = false } = {}) {
    this.recordValueLookupStatement.run({
      id: productId,
      now: nowIso(),
      next_at: found ? null : nextAt,
      status: found ? "found" : error ? "error" : "missing"
    });
    return this.findProductByIdStatement.get(productId);
  }

  markMissingProducts(inventoryAt, sectionNames = null) {
    if (!inventoryAt) {
      return 0;
    }

    const sections = Array.isArray(sectionNames)
      ? sectionNames.map((section) => String(section || "").trim()).filter(Boolean)
      : [];
    const sectionFilter =
      sections.length > 0 ? `AND section IN (${sections.map((_, index) => `@section${index}`).join(", ")})` : "";
    const params = {
      disappeared_at: nowIso(),
      inventory_at: inventoryAt
    };
    sections.forEach((section, index) => {
      params[`section${index}`] = section;
    });

    const info = this.db
      .prepare(
        `UPDATE products
         SET present_now = 0,
             disappeared_at = COALESCE(disappeared_at, @disappeared_at)
         WHERE present_now = 1
           AND COALESCE(last_inventory_at, '') != @inventory_at
           ${sectionFilter}`
      )
      .run(params);
    return info.changes || 0;
  }

  getSettings() {
    const settings = {};
    for (const row of this.getSettingsStatement.all()) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  getSetting(key, fallback = "") {
    const row = this.getSettingStatement.get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.setSettingStatement.run(String(key), String(value), nowIso());
  }

  deleteSetting(key) {
    this.deleteSettingStatement.run(String(key));
  }

  recordScanCycle(summary) {
    if (!summary) {
      return;
    }

    const maxScore = Number(summary.maxScore);
    this.insertScanCycleStatement.run({
      started_at: summary.startedAt || nowIso(),
      completed_at: summary.completedAt || nowIso(),
      scanned: Number(summary.scanned || 0),
      new_products: Number(summary.newProducts || 0),
      notified: Number(summary.notified || 0),
      max_score: Number.isFinite(maxScore) ? maxScore : null,
      duration_seconds: Number(summary.elapsedSeconds || 0),
      outcome: String(summary.outcome || ""),
      reason_no_notifications: String(summary.reasonNoNotifications || ""),
      sections_json: JSON.stringify(summary.sections || []),
      layout_warnings_json: JSON.stringify(summary.layoutWarnings || []),
      success: summary.success === false ? 0 : 1,
      failure_kind: String(summary.failureKind || ""),
      error_text: truncate(summary.error || "", 4000),
      disappeared_products: Number(summary.disappearedProducts || 0),
      telegram_failures: Number(summary.telegramFailures || 0),
      section_failures_json: JSON.stringify(summary.sectionFailures || [])
    });
  }

  recentScanCycles(limit = 5) {
    return this.db
      .prepare(
        `SELECT id, started_at, completed_at, scanned, new_products, notified, max_score,
                duration_seconds, outcome, reason_no_notifications, sections_json, layout_warnings_json,
                success, failure_kind, error_text, disappeared_products, telegram_failures, section_failures_json
         FROM scan_cycles
         ORDER BY completed_at DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(50, Number(limit) || 5)));
  }

  searchProducts(query, limit = 5) {
    const term = String(query || "").trim().toLowerCase();
    if (!term) {
      return [];
    }

    const like = `%${term}%`;
    return this.db
      .prepare(
        `SELECT id, identity_key, asin, title, normalized_title, url, section_url, image_url, section, estimated_value_eur,
                first_seen_at, last_seen_at, score, reasons_json, notified, raw_text,
                present_now, disappeared_at, reappeared_count, last_notified_at,
                first_score, first_reasons_json, last_triggers_json, last_blockers_json,
                last_config_json, last_decision, vine_recommendation_id, vine_card_asin,
                vine_recommendation_type, value_lookup_attempts, value_lookup_last_at,
                value_lookup_next_at, value_lookup_status, telegram_chat_id, telegram_message_id,
                telegram_message_kind
         FROM products
         WHERE lower(title) LIKE @like
            OR lower(normalized_title) LIKE @like
            OR lower(asin) = @term
            OR lower(raw_text) LIKE @like
         ORDER BY last_seen_at DESC, score DESC
         LIMIT @limit`
      )
      .all({
        like,
        term,
        limit: Math.max(1, Math.min(20, Number(limit) || 5))
      });
  }

  recentProducts({ limit = 10, mode = "all" } = {}) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
    const clauses = {
      all: "",
      notified: "WHERE notified = 1",
      unnotified: "WHERE notified != 1",
      ignored: "WHERE notified != 1",
      present: "WHERE present_now = 1",
      gone: "WHERE present_now = 0",
      reappeared: "WHERE reappeared_count > 0",
      top: ""
    };
    const order =
      mode === "top"
        ? "ORDER BY score DESC, estimated_value_eur DESC, last_seen_at DESC"
        : mode === "ignored"
          ? "ORDER BY score ASC, last_seen_at DESC"
          : "ORDER BY last_seen_at DESC";
    const where = clauses[mode] === undefined ? clauses.all : clauses[mode];

    return this.db
      .prepare(
        `SELECT id, identity_key, asin, title, normalized_title, url, section_url, image_url, section, estimated_value_eur,
                first_seen_at, last_seen_at, score, reasons_json, notified, raw_text,
                present_now, disappeared_at, reappeared_count, last_notified_at,
                first_score, first_reasons_json, last_triggers_json, last_blockers_json,
                last_config_json, last_decision, vine_recommendation_id, vine_card_asin,
                vine_recommendation_type, value_lookup_attempts, value_lookup_last_at,
                value_lookup_next_at, value_lookup_status, telegram_chat_id, telegram_message_id,
                telegram_message_kind
         FROM products
         ${where}
         ${order}
         LIMIT ?`
      )
      .all(safeLimit);
  }

  getStats() {
    const totals = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN notified = 1 THEN 1 ELSE 0 END) AS notified,
          SUM(CASE WHEN present_now = 1 THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN present_now = 0 THEN 1 ELSE 0 END) AS gone,
          SUM(CASE WHEN reappeared_count > 0 THEN 1 ELSE 0 END) AS reappeared,
          SUM(CASE WHEN estimated_value_eur IS NULL AND COALESCE(vine_recommendation_id, '') != '' THEN 1 ELSE 0 END)
            AS value_lookup_pending,
          MAX(score) AS max_score,
          AVG(score) AS avg_score,
          MAX(estimated_value_eur) AS max_estimated_value_eur
        FROM products`
      )
      .get();

    const bySection = this.db
      .prepare(
        `SELECT section, COUNT(*) AS total, SUM(CASE WHEN notified = 1 THEN 1 ELSE 0 END) AS notified,
                SUM(CASE WHEN present_now = 1 THEN 1 ELSE 0 END) AS present
         FROM products
         GROUP BY section
         ORDER BY total DESC`
      )
      .all();

    const topProducts = this.db
      .prepare(
        `SELECT id, asin, title, section, estimated_value_eur, score, notified, present_now,
                first_seen_at, last_seen_at, disappeared_at, url, section_url
         FROM products
         ORDER BY score DESC, estimated_value_eur DESC, first_seen_at DESC
         LIMIT 20`
      )
      .all();

    const scanCycles = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
                MAX(completed_at) AS last_completed_at
         FROM scan_cycles`
      )
      .get();

    return {
      totals,
      bySection,
      topProducts,
      scanCycles
    };
  }

  exportCsv(outputPath) {
    const rows = this.db
      .prepare(
        `SELECT id, identity_key, asin, title, normalized_title, url, section_url, image_url, section, estimated_value_eur,
                first_seen_at, last_seen_at, score, reasons_json, notified, present_now, disappeared_at,
                reappeared_count, last_notified_at, last_decision, last_triggers_json, last_blockers_json,
                vine_recommendation_id, vine_card_asin, vine_recommendation_type,
                value_lookup_attempts, value_lookup_last_at, value_lookup_next_at, value_lookup_status,
                telegram_chat_id, telegram_message_id, telegram_message_kind
         FROM products
         ORDER BY first_seen_at DESC`
      )
      .all();

    ensureDirForFile(outputPath);
    const headers = [
      "id",
      "identity_key",
      "asin",
      "title",
      "normalized_title",
      "url",
      "section_url",
      "image_url",
      "section",
      "estimated_value_eur",
      "first_seen_at",
      "last_seen_at",
      "score",
      "reasons_json",
      "notified",
      "present_now",
      "disappeared_at",
      "reappeared_count",
      "last_notified_at",
      "last_decision",
      "last_triggers_json",
      "last_blockers_json",
      "vine_recommendation_id",
      "vine_card_asin",
      "vine_recommendation_type",
      "value_lookup_attempts",
      "value_lookup_last_at",
      "value_lookup_next_at",
      "value_lookup_status",
      "telegram_chat_id",
      "telegram_message_id",
      "telegram_message_kind"
    ];
    const lines = [
      headers.join(","),
      ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(","))
    ];
    fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
    return {
      outputPath,
      count: rows.length
    };
  }

  cleanup({ productDays = 0, scanCycleDays = 0, vacuum = false } = {}) {
    const result = {
      deletedProducts: 0,
      deletedScanCycles: 0,
      vacuumed: false
    };

    if (Number(productDays) > 0) {
      const cutoff = new Date(Date.now() - Number(productDays) * 24 * 60 * 60 * 1000).toISOString();
      result.deletedProducts = this.db
        .prepare("DELETE FROM products WHERE present_now = 0 AND last_seen_at < ?")
        .run(cutoff).changes;
    }

    if (Number(scanCycleDays) > 0) {
      const cutoff = new Date(Date.now() - Number(scanCycleDays) * 24 * 60 * 60 * 1000).toISOString();
      result.deletedScanCycles = this.db
        .prepare("DELETE FROM scan_cycles WHERE completed_at < ?")
        .run(cutoff).changes;
    }

    if (vacuum) {
      this.db.exec("VACUUM");
      result.vacuumed = true;
    }

    return result;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = {
  ProductStorage
};
