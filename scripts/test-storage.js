"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ProductStorage } = require("../src/storage");
const { identityKey, normalizeTitle } = require("../src/utils");

const logger = { info() {}, warn() {}, error() {} };
const asinSql = `SELECT * FROM products
  WHERE upper(COALESCE(asin, '')) = @asin
     OR upper(COALESCE(vine_card_asin, '')) = @asin
  ORDER BY id ASC LIMIT 1`;

// Independent copy of the previous lookup order, deliberately without caching.
function referenceLookup(db, product) {
  const normalizedTitle = product.normalized_title || normalizeTitle(product.title);
  const asin = String(product.asin || product.vine_card_asin || "").trim().toUpperCase();
  const recommendation = String(product.vine_recommendation_id || "").trim();
  const url = String(product.url || "").trim();
  const key = identityKey({ ...product, normalized_title: normalizedTitle });
  const queries = [];
  if (key && !key.startsWith("title:")) {
    queries.push(["SELECT * FROM products WHERE identity_key = ? ORDER BY id ASC LIMIT 1", key]);
  }
  if (asin) queries.push([asinSql, { asin }]);
  if (recommendation) queries.push([
    "SELECT * FROM products WHERE vine_recommendation_id = ? ORDER BY id ASC LIMIT 1", recommendation
  ]);
  if (url) queries.push(["SELECT * FROM products WHERE url = ? ORDER BY id ASC LIMIT 1", url]);
  for (const [sql, params] of queries) {
    const found = db.prepare(sql).get(params);
    if (found) return found;
  }
  if (asin || recommendation || url || !normalizedTitle) return null;
  return db.prepare("SELECT * FROM products WHERE normalized_title = ? ORDER BY id ASC LIMIT 1")
    .get(normalizedTitle);
}

function addRow(storage, fields = {}) {
  return storage.db.prepare(`INSERT INTO products
    (identity_key, asin, vine_card_asin, vine_recommendation_id, url, title,
     normalized_title, first_seen_at, last_seen_at)
    VALUES (@key, @asin, @card, @recommendation, @url, @title, @normalized, @at, @at)`)
    .run({ key: "", asin: "", card: "", recommendation: "", url: "",
      title: "Fixture product", normalized: "fixture product", at: "2026-10-28T00:00:00.000Z", ...fields })
    .lastInsertRowid;
}

function fixture() {
  const storage = new ProductStorage(":memory:", logger);
  storage.init();
  return storage;
}

function testLegacyLookupsAndIdentityPrecedence() {
  const storage = fixture();
  try {
    const oldest = addRow(storage, { asin: "b000000001", card: "b000000002", recommendation: "shared-rec",
      url: "https://example.invalid/one", title: "Identical title", normalized: "identical title" });
    addRow(storage, { asin: "B000000002", recommendation: "shared-rec", normalized: "identical title" });
    const canonical = addRow(storage, { key: "asin:B000000001", asin: "OTHERASIN" });
    addRow(storage, { key: "recommendation:canonical-rec", recommendation: "different-rec" });
    addRow(storage, { key: "url:https://example.invalid/canonical" });
    addRow(storage, { asin: null, card: null, normalized: "without identity" });
    addRow(storage, { asin: " B000000003 ", normalized: "padded legacy" });
    const inputs = [
      { asin: " b000000001 " }, // Canonical key wins over an older fallback row.
      { asin: "b000000002" }, // Oldest row wins across ASIN and variant columns.
      { vine_card_asin: "B000000002" },
      { vine_recommendation_id: " shared-rec " },
      { vine_recommendation_id: "canonical-rec" },
      { url: "https://example.invalid/one" },
      { url: "https://example.invalid/canonical" },
      { title: "Identical title" },
      { title: "Without identity" },
      { title: "Identical title", asin: "B0NOTFOUND" },
      { title: "Identical title", vine_recommendation_id: "missing-rec" },
      { title: "Identical title", url: "https://example.invalid/missing" },
      { asin: "B000000003" }, // Do not silently trim stored legacy identities.
      { title: "" }, {},
      { asin: "missing", vine_recommendation_id: "shared-rec" },
      { asin: "missing", url: "https://example.invalid/one" }
    ];
    for (const product of inputs) {
      assert.deepEqual(storage.findExisting(product), referenceLookup(storage.db, product));
    }
    assert.equal(storage.findExisting({ asin: "B000000001" }).id, canonical);
    assert.equal(storage.findExisting({ asin: "B000000002" }).id, oldest);
    assert.equal(storage.findExisting({ title: "Identical title", asin: "B0NOTFOUND" }), null);

    const insertNoise = storage.db.transaction(() => {
      for (let i = 0; i < 200; i++) addRow(storage, { asin: `NOISE${i}`, card: `VARIANT${i}` });
    });
    insertNoise();
    const plan = storage.db.prepare(`EXPLAIN QUERY PLAN ${asinSql}`).all({ asin: "MISSING" })
      .map(row => row.detail).join("\n");
    assert.match(plan, /idx_products_asin_folded/);
    assert.match(plan, /idx_products_card_asin_folded/);
    assert.doesNotMatch(plan, /SCAN (?:TABLE )?products\b/);
  } finally { storage.close(); }
}

function testPreparedStatementsReadFreshRows() {
  const storage = fixture();
  try {
    const id = addRow(storage, { key: "asin:B000000001", asin: "B000000001" });
    const update = storage.db.prepare("UPDATE products SET notified=1, present_now=0, estimated_value_eur=42 WHERE id=?");
    const insert = storage.db.prepare(`INSERT INTO products
      (identity_key, title, first_seen_at, last_seen_at)
      VALUES ('asin:B000000099', 'New fixture', '2026-10-28', '2026-10-28')`);
    const cases = [
      { asin: "B000000001" }, { asin: "missing" }, { vine_card_asin: "missing" },
      { vine_recommendation_id: "missing" }, { url: "https://example.invalid/missing" },
      { title: "Fixture product" }, { title: "Unknown title" }
    ];
    const expected = cases.map(product => referenceLookup(storage.db, product));
    storage.db.prepare = () => { throw new Error("Lookup must reuse SQL without caching product rows"); };
    for (let repeat = 0; repeat < 10; repeat++) {
      cases.forEach((product, i) => assert.deepEqual(storage.findExisting(product), expected[i]));
    }
    update.run(id);
    const changed = storage.findExisting({ asin: "B000000001" });
    assert.equal(changed.notified, 1);
    assert.equal(changed.present_now, 0);
    assert.equal(changed.estimated_value_eur, 42);
    assert.equal(storage.findExisting({ asin: "B000000099" }), null);
    insert.run();
    assert.ok(storage.findExisting({ asin: "B000000099" }), "A previous miss must not be cached");
  } finally { storage.close(); }
}

function testLegacyMigrationAndReopen() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vine-storage-migration-"));
  const database = path.join(directory, "fixture.sqlite");
  let storage;
  try {
    storage = new ProductStorage(database, logger);
    storage.init();
    const id = addRow(storage, { asin: "b000000007", card: "b000000008" });
    storage.db.prepare("UPDATE products SET notified=1, estimated_value_eur=99 WHERE id=?").run(id);
    storage.db.exec("DROP INDEX idx_products_asin_folded; DROP INDEX idx_products_card_asin_folded;");
    storage.close();
    for (let reopen = 0; reopen < 2; reopen++) {
      storage = new ProductStorage(database, logger);
      storage.init();
      for (const asin of ["B000000007", "B000000008"]) {
        const found = storage.findExisting({ asin });
        assert.equal(found.id, id);
        assert.equal(found.notified, 1);
        assert.equal(found.estimated_value_eur, 99);
      }
      const indexes = storage.db.prepare("PRAGMA index_list(products)").all().map(row => row.name);
      for (const name of ["idx_products_asin", "idx_products_asin_folded", "idx_products_card_asin_folded"]) {
        assert.ok(indexes.includes(name), `Missing index after migration: ${name}`);
      }
      assert.equal(storage.db.prepare("SELECT count(*) AS n FROM products").get().n, 1);
      storage.close();
    }
  } finally {
    if (storage && storage.db && storage.db.open) storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const test of [testLegacyLookupsAndIdentityPrecedence, testPreparedStatementsReadFreshRows,
  testLegacyMigrationAndReopen]) {
  test();
  console.log(`OK ${test.name}`);
}
