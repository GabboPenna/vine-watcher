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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function boldKey(key, value) {
  return `<b>${escapeHtml(key)}</b>: ${escapeHtml(value)}`;
}

function compactItems(items, fallback = "none") {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  return values.length > 0 ? values.join(" | ") : fallback;
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
    const estimatedValue = formatEuro(product.estimated_value_eur) || "not visible on Vine card";
    const vineUrl = product.section_url || product.url || "";
    const lines = [
      "\u{1F6A8} Vine match",
      boldKey("Title", product.title || "Untitled product"),
      boldKey("Value/price", estimatedValue),
      `<b>Score</b>: ${escapeHtml(scoring.score)} | <b>Signals</b>: +${escapeHtml(scoring.positiveSignals || 0)} / -${escapeHtml(scoring.negativeSignals || 0)}`,
      boldKey("Section", product.section || "n/a"),
      boldKey("Reasons", compactItems(reasons, "no specific reason"))
    ];

    if (triggers.length > 0) {
      lines.push(boldKey("Triggers", compactItems(triggers)));
    }

    if (vineUrl) {
      lines.push(boldKey("Open Vine section", vineUrl));
    }

    if (product.asin) {
      lines.push(boldKey("ASIN", product.asin));
    }

    return lines.join("\n");
  }

  formatProductPhotoCaption(product, scoring) {
    const estimatedValue = formatEuro(product.estimated_value_eur) || "not visible";
    const vineUrl = product.section_url || product.url || "";
    const lines = [
      "\u{1F6A8} Vine match",
      escapeHtml(truncate(product.title || "Untitled product", 360)),
      `<b>Value/price</b>: ${escapeHtml(estimatedValue)} | <b>Score</b>: ${escapeHtml(scoring.score)} | +${escapeHtml(scoring.positiveSignals || 0)}/-${escapeHtml(scoring.negativeSignals || 0)}`
    ];

    if (vineUrl) {
      lines.push(boldKey("Open Vine section", vineUrl));
    }

    if (product.asin) {
      lines.push(boldKey("ASIN", product.asin));
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
        const caption = message.length <= 1024 ? message : this.formatProductPhotoCaption(product, scoring);
        await this.request("sendPhoto", {
          chat_id: this.chatId,
          photo: product.image_url,
          caption: truncate(caption, 1024),
          parse_mode: "HTML"
        });
        if (message.length > 1024) {
          await this.request("sendMessage", {
            chat_id: this.chatId,
            text: truncate(message, 4096),
            disable_web_page_preview: true,
            parse_mode: "HTML"
          });
        }
        return true;
      } catch (error) {
        this.logger.warn(`sendPhoto failed, falling back to sendMessage: ${error.message}`);
      }
    }

    await this.request("sendMessage", {
      chat_id: this.chatId,
      text: truncate(message, 4096),
      disable_web_page_preview: false,
      parse_mode: "HTML"
    });
    return true;
  }

  async sendText(text, options = {}) {
    if (!this.enabled) {
      this.logger.warn("Telegram token/chat id missing; text notification skipped");
      return false;
    }

    const payload = {
      chat_id: options.chat_id || this.chatId,
      text: truncate(text, 4096),
      disable_web_page_preview: options.disable_web_page_preview === undefined ? true : options.disable_web_page_preview
    };

    if (options.reply_markup) {
      payload.reply_markup = options.reply_markup;
    }

    if (options.parse_mode) {
      payload.parse_mode = options.parse_mode;
    }

    await this.request("sendMessage", payload);
    return true;
  }

  async editText(chatId, messageId, text, options = {}) {
    if (!this.enabled) {
      this.logger.warn("Telegram token/chat id missing; edit skipped");
      return false;
    }

    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: truncate(text, 4096),
      disable_web_page_preview: options.disable_web_page_preview === undefined ? true : options.disable_web_page_preview
    };

    if (options.reply_markup) {
      payload.reply_markup = options.reply_markup;
    }

    if (options.parse_mode) {
      payload.parse_mode = options.parse_mode;
    }

    await this.request("editMessageText", payload);
    return true;
  }

  async answerCallbackQuery(callbackQueryId, text = "") {
    if (!this.enabled) {
      this.logger.warn("Telegram token/chat id missing; callback answer skipped");
      return false;
    }

    await this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: truncate(text, 200)
    });
    return true;
  }

  async getUpdates(options = {}) {
    const payload = {
      timeout: options.timeout || 0,
      allowed_updates: ["message", "callback_query"]
    };

    if (options.offset !== undefined && options.offset !== null) {
      payload.offset = options.offset;
    }

    return this.request("getUpdates", payload);
  }

  async setCommands(commands, options = {}) {
    if (!this.enabled) {
      this.logger.warn("Telegram token/chat id missing; command menu skipped");
      return false;
    }

    await this.request("setMyCommands", {
      commands,
      ...options
    });
    return true;
  }

  async setChatMenuButton() {
    if (!this.enabled) {
      this.logger.warn("Telegram token/chat id missing; chat menu button skipped");
      return false;
    }

    await this.request("setChatMenuButton", {
      chat_id: this.chatId,
      menu_button: {
        type: "commands"
      }
    });
    return true;
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
