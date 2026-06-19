"use strict";

const { truncate } = require("./utils");

function formatEuro(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return `\u20ac${parsed.toFixed(2)}`;
}

class TelegramClient {
  constructor(config, logger) {
    this.token = config.telegramBotToken;
    this.chatId = config.telegramChatId;
    this.logger = logger;
    this.enabled = Boolean(this.token && this.chatId);
  }

  async request(method, payload) {
    if (!this.enabled) {
      this.logger.warn("Telegram is not configured; skipping request");
      return null;
    }

    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    let body = null;
    try {
      body = await response.json();
    } catch (_error) {
      body = {};
    }

    if (!response.ok || !body.ok) {
      const description = body.description || `${response.status} ${response.statusText}`;
      throw new Error(`Telegram ${method} failed: ${description}`);
    }

    return body.result;
  }

  formatProductMessage(product, scoring) {
    const reasons = scoring.reasons && scoring.reasons.length > 0 ? scoring.reasons : ["no specific reason"];
    const triggers =
      scoring.notificationTriggers && scoring.notificationTriggers.length > 0
        ? scoring.notificationTriggers
        : [];
    const estimatedValue = formatEuro(product.estimated_value_eur);
    const vineUrl = product.section_url || product.url || "";
    const lines = [
      "\u{1F6A8} New interesting Vine product",
      "",
      `Score: ${scoring.score}`,
      `Signals: ${scoring.positiveSignals || 0} positive / ${scoring.negativeSignals || 0} negative`,
      `Section: ${product.section || "n/a"}`,
      "",
      "Title:",
      product.title || "Untitled product",
      "",
      "Reasons:",
      ...reasons.map((reason) => `- ${reason}`)
    ];

    if (estimatedValue) {
      lines.splice(4, 0, `Estimated value: ${estimatedValue}`);
    }

    if (triggers.length > 0) {
      lines.push("", "Notification trigger:", ...triggers.map((trigger) => `- ${trigger}`));
    }

    if (vineUrl) {
      lines.push("", "Open Vine section:", vineUrl);
    }

    if (product.asin) {
      lines.push("", `ASIN: ${product.asin}`);
    }

    return lines.join("\n");
  }

  async sendProduct(product, scoring) {
    if (!this.enabled) {
      this.logger.warn("Telegram token/chat id missing; product notification skipped");
      return false;
    }

    const message = this.formatProductMessage(product, scoring);

    if (product.image_url) {
      try {
        await this.request("sendPhoto", {
          chat_id: this.chatId,
          photo: product.image_url,
          caption: truncate(message, 1024)
        });
        return true;
      } catch (error) {
        this.logger.warn(`sendPhoto failed, falling back to sendMessage: ${error.message}`);
      }
    }

    await this.request("sendMessage", {
      chat_id: this.chatId,
      text: truncate(message, 4096),
      disable_web_page_preview: false
    });
    return true;
  }

  async sendText(text) {
    if (!this.enabled) {
      this.logger.warn("Telegram token/chat id missing; text notification skipped");
      return false;
    }

    await this.request("sendMessage", {
      chat_id: this.chatId,
      text: truncate(text, 4096),
      disable_web_page_preview: true
    });
    return true;
  }

  async getUpdates(options = {}) {
    const payload = {
      timeout: options.timeout || 0,
      allowed_updates: ["message"]
    };

    if (options.offset !== undefined && options.offset !== null) {
      payload.offset = options.offset;
    }

    return this.request("getUpdates", payload);
  }

  async sendCriticalError(error) {
    const message = [
      "Vine Watcher needs attention",
      "",
      error && error.message ? error.message : String(error)
    ].join("\n");
    return this.sendText(message);
  }

  formatSessionAttentionMessage(error, details = {}) {
    const failureCount = details.failureCount || 1;
    const maxFailures = details.maxFailures || 1;
    const willStop = Boolean(details.willStop);
    return [
      "Vine Watcher: Amazon login required",
      "",
      error && error.message ? error.message : String(error),
      "",
      `Session health: ${failureCount}/${maxFailures} consecutive failures`,
      willStop ? "Watcher is stopping to avoid repeated Amazon retries." : "Watcher will retry after the next scan delay.",
      "",
      "Manual recovery:",
      "sudo /opt/vine-watcher-telegram/scripts/server-login.sh start",
      "# complete Amazon login in noVNC",
      "sudo /opt/vine-watcher-telegram/scripts/server-login.sh finish",
      "sudo systemctl start vine-watcher.service"
    ].join("\n");
  }

  async sendSessionAttention(error, details = {}) {
    return this.sendText(this.formatSessionAttentionMessage(error, details));
  }
}

module.exports = {
  TelegramClient
};
