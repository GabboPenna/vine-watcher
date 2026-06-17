"use strict";

const fs = require("fs");
const Database = require("better-sqlite3");
const {
  ensureDirForFile,
  escapeCsv,
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
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        raw_text TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_products_asin ON products(asin);
      CREATE INDEX IF NOT EXISTS idx_products_url ON products(url);
      CREATE INDEX IF NOT EXISTS idx_products_normalized_title ON products(normalized_title);
      CREATE INDEX IF NOT EXISTS idx_products_score ON products(score);
      CREATE INDEX IF NOT EXISTS idx_products_notified ON products(notified);
      CREATE INDEX IF NOT EXISTS idx_products_last_seen_at ON products(last_seen_at);
    `);
    this.migrate();
    this.prepareStatements();
    this.logger.info(`SQLite ready at ${this.databasePath}`);
  }

  migrate() {
    const columns = this.db.prepare("PRAGMA table_info(products)").all().map((column) => column.name);
    if (!columns.includes("section_url")) {
      this.db.exec("ALTER TABLE products ADD COLUMN section_url TEXT");
    }
    if (!columns.includes("estimated_value_eur")) {
      this.db.exec("ALTER TABLE products ADD COLUMN estimated_value_eur REAL");
    }
  }

  prepareStatements() {
    this.insertProduct = this.db.prepare(`
      INSERT INTO products (
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
        raw_text
      ) VALUES (
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
        @raw_text
      )
    `);

    this.updateProduct = this.db.prepare(`
      UPDATE products
      SET
        asin = COALESCE(NULLIF(@asin, ''), asin),
        title = @title,
        normalized_title = COALESCE(NULLIF(@normalized_title, ''), normalized_title),
        url = COALESCE(NULLIF(@url, ''), url),
        section_url = COALESCE(NULLIF(@section_url, ''), section_url),
        image_url = COALESCE(NULLIF(@image_url, ''), image_url),
        section = @section,
        estimated_value_eur = @estimated_value_eur,
        last_seen_at = @now,
        score = @score,
        reasons_json = @reasons_json,
        raw_text = @raw_text
      WHERE id = @id
    `);

    this.markNotifiedStatement = this.db.prepare(`
      UPDATE products
      SET notified = 1
      WHERE id = ?
    `);
  }

  findExisting(product) {
    const normalizedTitle = product.normalized_title || normalizeTitle(product.title);
    const clauses = [];
    const params = {};

    if (product.asin) {
      clauses.push("asin = @asin");
      params.asin = product.asin;
    }
    if (product.url) {
      clauses.push("url = @url");
      params.url = product.url;
    }
    if (normalizedTitle) {
      clauses.push("normalized_title = @normalized_title");
      params.normalized_title = normalizedTitle;
    }

    if (clauses.length === 0) {
      return null;
    }

    return this.db
      .prepare(`SELECT * FROM products WHERE ${clauses.join(" OR ")} ORDER BY id ASC LIMIT 1`)
      .get(params);
  }

  saveProduct(product, scoring) {
    const now = nowIso();
    const normalizedTitle = product.normalized_title || normalizeTitle(product.title);
    const payload = {
      asin: product.asin || "",
      title: truncate(product.title || "Untitled product", 1000),
      normalized_title: normalizedTitle,
      url: product.url || "",
      section_url: product.section_url || "",
      image_url: product.image_url || "",
      section: product.section || "",
      estimated_value_eur: normalizeEstimatedValue(product.estimated_value_eur),
      now,
      score: scoring.score,
      reasons_json: JSON.stringify(scoring.reasons || []),
      raw_text: truncate(product.raw_text || "", 4000)
    };

    const existing = this.findExisting(payload);
    if (existing) {
      this.updateProduct.run({ ...payload, id: existing.id });
      return {
        isNew: false,
        product: {
          ...existing,
          ...payload,
          id: existing.id,
          first_seen_at: existing.first_seen_at,
          last_seen_at: now,
          notified: existing.notified
        }
      };
    }

    const info = this.insertProduct.run(payload);
    return {
      isNew: true,
      product: {
        id: info.lastInsertRowid,
        ...payload,
        first_seen_at: now,
        last_seen_at: now,
        notified: 0
      }
    };
  }

  markNotified(productId) {
    this.markNotifiedStatement.run(productId);
  }

  getStats() {
    const totals = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN notified = 1 THEN 1 ELSE 0 END) AS notified,
          MAX(score) AS max_score,
          AVG(score) AS avg_score,
          MAX(estimated_value_eur) AS max_estimated_value_eur
        FROM products`
      )
      .get();

    const bySection = this.db
      .prepare(
        `SELECT section, COUNT(*) AS total, SUM(CASE WHEN notified = 1 THEN 1 ELSE 0 END) AS notified
         FROM products
         GROUP BY section
         ORDER BY total DESC`
      )
      .all();

    const topProducts = this.db
      .prepare(
        `SELECT id, asin, title, section, estimated_value_eur, score, notified, first_seen_at, url, section_url
         FROM products
         ORDER BY score DESC, estimated_value_eur DESC, first_seen_at DESC
         LIMIT 20`
      )
      .all();

    return {
      totals,
      bySection,
      topProducts
    };
  }

  exportCsv(outputPath) {
    const rows = this.db
      .prepare(
        `SELECT id, asin, title, normalized_title, url, section_url, image_url, section, estimated_value_eur, first_seen_at, last_seen_at, score, reasons_json, notified
         FROM products
         ORDER BY first_seen_at DESC`
      )
      .all();

    ensureDirForFile(outputPath);
    const headers = [
      "id",
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
      "notified"
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
