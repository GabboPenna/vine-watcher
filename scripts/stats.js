"use strict";

const { loadConfig } = require("../src/config");
const { createLogger } = require("../src/logger");
const { ProductStorage } = require("../src/storage");

function printTable(rows, columns) {
  if (!rows.length) {
    console.log("(no data)");
    return;
  }
  console.table(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))));
}

function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel }).child("stats");
  const storage = new ProductStorage(config.databasePath, logger);
  storage.init();

  const stats = storage.getStats();
  console.log("Totals");
  console.table([stats.totals]);
  console.log("By section");
  printTable(stats.bySection, ["section", "total", "present", "notified"]);
  console.log("Top products");
  printTable(stats.topProducts, [
    "id",
    "score",
    "estimated_value_eur",
    "present_now",
    "notified",
    "section",
    "asin",
    "title"
  ]);

  storage.close();
}

main();
