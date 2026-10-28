"use strict";

// Local synthetic SQLite databases only. No .env, live database or network.
// Usage: node scripts/benchmark-storage.js /path/to/previous/src/storage.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const Previous = require(path.resolve(process.argv[2])).ProductStorage;
const Current = require("../src/storage").ProductStorage;
const logger = { info() {}, warn() {}, error() {} };
const rows = 26000;
const rounds = 20;
const score = { score: 0, reasons: [] };
const diagnostics = { inventoryAt: "2026-10-28T00:00:00.000Z" };
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const round = value => Number(value.toFixed(4));
const asin = index => `B${String(index).padStart(9, "0")}`;
const product = index => ({ asin: asin(index), title: `Storage fixture ${index}`,
  normalized_title: `storage fixture ${index}`, url: `https://example.invalid/dp/${asin(index)}`,
  section: "Fixture section", raw_text: "Synthetic product details ".repeat(40) });

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vine-storage-benchmark-"));
  const variants = [];
  try {
    for (const [name, Storage] of [["before", Previous], ["after", Current]]) {
      const storage = new Storage(path.join(directory, `${name}.sqlite`), logger);
      storage.init();
      variants.push({ name, storage, compilations: 0, next: 900000 });
      const insert = storage.db.prepare(`INSERT INTO products
        (identity_key, asin, title, normalized_title, url, section, raw_text, first_seen_at, last_seen_at)
        VALUES (@identity, @asin, @title, @normalized_title, @url, @section, @raw_text, @at, @at)`);
      storage.db.transaction(() => {
        for (let i = 1; i <= rows; i++) insert.run({ ...product(i), identity: `asin:${asin(i)}`,
          at: diagnostics.inventoryAt });
        storage.db.prepare(`INSERT INTO products
          (identity_key, vine_card_asin, title, first_seen_at, last_seen_at)
          VALUES ('legacy-key', 'b000999999', 'Legacy variant', @at, @at)`)
          .run({ at: diagnostics.inventoryAt });
      })();
    }

    const checks = [
      ...Array.from({ length: 36 }, (_, i) => product(i + 1)),
      { asin: "B099999999" }, { asin: "B000999999" }, { title: "Storage fixture 20" },
      { title: "Storage fixture 20", asin: "B099999999" }
    ];
    for (const item of checks) {
      assert.deepEqual(variants[1].storage.findExisting(item), variants[0].storage.findExisting(item));
    }

    const upgradePath = path.join(directory, "upgrade.sqlite");
    await variants[0].storage.db.backup(upgradePath);
    const upgrade = new Current(upgradePath, logger);
    const migrationStart = performance.now();
    try {
      upgrade.init();
      assert.equal(upgrade.db.prepare("SELECT count(*) AS n FROM products").get().n, rows + 1);
      assert.equal(upgrade.findExisting({ asin: "B000999999" }).title, "Legacy variant");
    } finally { upgrade.close(); }
    const migrationMs = performance.now() - migrationStart;

    for (const variant of variants) {
      const prepare = variant.storage.db.prepare.bind(variant.storage.db);
      variant.storage.db.prepare = (...args) => { variant.compilations++; return prepare(...args); };
    }
    const workloads = [
      { name: "existing_identity_36", run: ({ storage }) => {
        for (let i = 1; i <= 36; i++) assert.ok(storage.findExisting(product(i)));
      } },
      { name: "missing_asin", run: ({ storage }) => assert.equal(storage.findExisting({ asin: "B099999999" }), null) },
      { name: "legacy_variant", run: ({ storage }) => assert.ok(storage.findExisting({ asin: "B000999999" })) },
      { name: "persist_existing_36", run: ({ storage }) => {
        for (let i = 1; i <= 36; i++) {
          const input = product(i);
          const existing = storage.findExisting(input);
          storage.saveProduct({ ...existing, ...input }, score, diagnostics);
        }
      } },
      { name: "persist_new_product", run: variant => {
        const input = product(variant.next++);
        assert.equal(variant.storage.findExisting(input), null);
        assert.equal(variant.storage.saveProduct(input, score, diagnostics).isNew, true);
      } }
    ];
    const report = [];
    for (const workload of workloads) {
      for (let i = 0; i < 3; i++) for (const variant of variants) workload.run(variant);
      const samples = { before: [], after: [] };
      const cpuSamples = { before: [], after: [] };
      const preparations = Object.fromEntries(variants.map(v => [v.name, v.compilations]));
      for (let i = 0; i < rounds; i++) {
        for (const variant of i % 2 ? [...variants].reverse() : variants) {
          const cpu = process.cpuUsage();
          const start = performance.now();
          workload.run(variant);
          samples[variant.name].push(performance.now() - start);
          const elapsed = process.cpuUsage(cpu);
          cpuSamples[variant.name].push((elapsed.user + elapsed.system) / 1000);
        }
      }
      report.push({ workload: workload.name, rounds,
        ...Object.fromEntries(variants.map(variant => [variant.name, {
          medianMs: round(percentile(samples[variant.name], .5)),
          p95Ms: round(percentile(samples[variant.name], .95)),
          maxMs: round(Math.max(...samples[variant.name])),
          medianCpuMs: round(percentile(cpuSamples[variant.name], .5)),
          sqlPreparations: variant.compilations - preparations[variant.name]
        }])) });
    }
    const estimatedDatabaseMiB = Object.fromEntries(variants.map(({ name, storage }) => [name,
      round(storage.db.pragma("page_count", { simple: true }) *
        storage.db.pragma("page_size", { simple: true }) / 1048576)
    ]));
    console.log(JSON.stringify({ syntheticOnly: true, node: process.version,
      sqlite: variants[1].storage.db.prepare("SELECT sqlite_version() AS version").get().version,
      initialRows: rows + 1, equivalentLookups: checks.length,
      migrationAndReopenMs: round(migrationMs), estimatedDatabaseMiB, workloads: report }, null, 2));
  } finally {
    for (const variant of variants) variant.storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
