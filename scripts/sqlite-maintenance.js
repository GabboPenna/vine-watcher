"use strict";

const Database = require("better-sqlite3");

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function main() {
  const databasePath = arg("--database");
  if (!databasePath) {
    throw new Error("--database is required");
  }

  const productDays = positiveNumber(arg("--product-days", "0"));
  const scanCycleDays = positiveNumber(arg("--scan-cycle-days", "0"));
  const vacuum = process.argv.includes("--vacuum");
  const db = new Database(databasePath);
  const result = {
    deletedProducts: 0,
    deletedScanCycles: 0,
    checkpointed: false,
    vacuumed: false
  };

  try {
    db.pragma("busy_timeout = 10000");
    if (productDays > 0) {
      const cutoff = new Date(Date.now() - productDays * 24 * 60 * 60 * 1000).toISOString();
      result.deletedProducts = db
        .prepare("DELETE FROM products WHERE present_now = 0 AND last_seen_at < ?")
        .run(cutoff).changes;
    }
    if (scanCycleDays > 0) {
      const cutoff = new Date(Date.now() - scanCycleDays * 24 * 60 * 60 * 1000).toISOString();
      result.deletedScanCycles = db.prepare("DELETE FROM scan_cycles WHERE completed_at < ?").run(cutoff).changes;
    }

    db.pragma("optimize");
    db.pragma("wal_checkpoint(PASSIVE)");
    result.checkpointed = true;
    if (vacuum) {
      db.exec("VACUUM");
      result.vacuumed = true;
    }
  } finally {
    db.close();
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
