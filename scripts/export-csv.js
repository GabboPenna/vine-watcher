"use strict";

const path = require("path");
const { loadConfig } = require("../src/config");
const { createLogger } = require("../src/logger");
const { ProductStorage } = require("../src/storage");

function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel }).child("export-csv");
  const storage = new ProductStorage(config.databasePath, logger);
  const outputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(config.projectRoot, "data", "products-export.csv");

  storage.init();
  const result = storage.exportCsv(outputPath);
  storage.close();

  console.log(`Exported ${result.count} products to ${result.outputPath}`);
}

main();
