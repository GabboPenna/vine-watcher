"use strict";

const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};

function sanitize(message) {
  return String(message)
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[telegram-token]")
    .replace(/(TELEGRAM_BOT_TOKEN=).+/g, "$1[redacted]");
}

function createLogger(options = {}) {
  const levelName = String(options.level || "info").toLowerCase();
  const currentLevel = LEVELS[levelName] || LEVELS.info;
  const scope = options.scope || "";

  function write(level, args) {
    if ((LEVELS[level] || LEVELS.info) < currentLevel) {
      return;
    }
    const timestamp = new Date().toISOString();
    const prefix = scope ? `[${scope}]` : "";
    const line = args.map((arg) => {
      if (arg instanceof Error) {
        return sanitize(`${arg.name}: ${arg.message}\n${arg.stack || ""}`);
      }
      if (typeof arg === "object") {
        return sanitize(JSON.stringify(arg));
      }
      return sanitize(arg);
    });
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[method](`${timestamp} ${level.toUpperCase()} ${prefix}`, ...line);
  }

  return {
    trace: (...args) => write("trace", args),
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    child: (childScope) =>
      createLogger({
        level: levelName,
        scope: scope ? `${scope}:${childScope}` : childScope
      })
  };
}

module.exports = {
  createLogger
};
