"use strict";

const path = require("path");
const { spawn } = require("child_process");

function runSqliteMaintenance(config) {
  const script = path.resolve(__dirname, "../scripts/sqlite-maintenance.js");
  const args = [
    script,
    "--database",
    config.databasePath,
    "--product-days",
    String(config.retentionProductsDays || 0),
    "--scan-cycle-days",
    String(config.retentionScanCyclesDays || 0)
  ];
  if (config.sqliteVacuumIntervalHours > 0) {
    args.push("--vacuum");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: config.projectRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-16000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`SQLite maintenance exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`SQLite maintenance returned invalid output: ${error.message}`));
      }
    });
  });
}

module.exports = {
  runSqliteMaintenance
};
