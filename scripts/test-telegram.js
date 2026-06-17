"use strict";

const { loadConfig } = require("../src/config");
const { createLogger } = require("../src/logger");
const { TelegramClient } = require("../src/telegram");

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel }).child("test-telegram");
  const telegram = new TelegramClient(config, logger);

  if (!telegram.enabled) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured in .env");
  }

  await telegram.sendText(`Vine Watcher Telegram test OK\n${new Date().toISOString()}`);
  logger.info("Telegram test message sent");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
