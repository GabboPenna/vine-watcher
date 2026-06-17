"use strict";

const fs = require("fs");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { createBrowserContext } = require("../src/browser");
const { loadConfig } = require("../src/config");
const { createLogger } = require("../src/logger");

function getArgValue(name) {
  const argIndex = process.argv.indexOf(name);
  return argIndex >= 0 ? process.argv[argIndex + 1] : "";
}

function getWaitSeconds() {
  const argValue = getArgValue("--wait-seconds");
  const value = Number(argValue || process.env.LOGIN_WAIT_SECONDS || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getWaitFile() {
  return getArgValue("--wait-file") || process.env.LOGIN_WAIT_FILE || "";
}

async function waitForFile(filePath) {
  fs.rmSync(filePath, { force: true });
  while (!fs.existsSync(filePath)) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function main() {
  const config = loadConfig({ headless: false });
  const logger = createLogger({ level: config.logLevel }).child("login");
  const context = await createBrowserContext(config, logger, { headless: false });
  const page = context.pages()[0] || (await context.newPage());
  const waitSeconds = getWaitSeconds();
  const waitFile = getWaitFile();
  const rl = waitSeconds > 0 || waitFile ? null : readline.createInterface({ input, output });

  try {
    logger.info("Opening Amazon Vine in a visible Chromium window");
    await page.goto(config.amazonVineBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.pageTimeoutMs
    });
  } catch (error) {
    logger.warn(`Initial page load failed: ${error.message}`);
  }

  console.log("");
  console.log("Complete Amazon login, 2FA, or any manual verification in the Chromium window.");
  console.log("This program does not read passwords, does not read cookies, and does not request Vine products.");
  console.log("");

  if (waitSeconds > 0) {
    console.log(`Server mode: you have ${waitSeconds} seconds to complete login. Chromium will close afterwards.`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  } else if (waitFile) {
    console.log(`Server mode: after login is complete, create this file to close Chromium: ${waitFile}`);
    await waitForFile(waitFile);
  } else {
    await rl.question("Quando Vine e' visibile e stabile, premi INVIO per salvare il profilo e chiudere: ");
  }

  await context.close();
  if (rl) {
    rl.close();
  }
  logger.info(`Profile saved in ${config.playwrightUserDataDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
