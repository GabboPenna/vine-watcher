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

function compactItems(items, fallback = "none") {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  return values.length > 0 ? values.join(" | ") : fallback;
}

function uniqueLimited(values, limit = 6) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(text);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function humanReasonValue(reason) {
  return String(reason || "")
    .replace(/^keyword (?:high|normal):\s*/i, "")
    .replace(/^negative keyword:\s*/i, "")
    .replace(/^brand:\s*/i, "")
    .replace(/^bonus:\s*/i, "")
    .replace(/^malus:\s*/i, "")
    .trim();
}

function reasonLines(reasons) {
  const groups = {
    keywords: [],
    brands: [],
    bonus: [],
    watch: [],
    other: []
  };

  for (const reason of reasons) {
    const text = String(reason || "").trim();
    if (/^keyword (?:high|normal):/i.test(text)) {
      groups.keywords.push(humanReasonValue(text));
    } else if (/^brand:/i.test(text)) {
      groups.brands.push(humanReasonValue(text));
    } else if (/^bonus:/i.test(text)) {
      groups.bonus.push(humanReasonValue(text));
    } else if (/^(negative keyword|malus):/i.test(text)) {
      groups.watch.push(humanReasonValue(text));
    } else if (text) {
      groups.other.push(text);
    }
  }

  const lines = [];
  const keywords = uniqueLimited(groups.keywords, 6);
  const brands = uniqueLimited(groups.brands, 4);
  const bonus = uniqueLimited(groups.bonus, 4);
  const watch = uniqueLimited(groups.watch, 4);
  const other = uniqueLimited(groups.other, 4);

  if (keywords.length > 0) {
    lines.push(`✅ <b>Keywords</b>: ${escapeHtml(keywords.join(", "))}`);
  }
  if (brands.length > 0) {
    lines.push(`🏷️ <b>Brand</b>: ${escapeHtml(brands.join(", "))}`);
  }
  if (bonus.length > 0) {
    lines.push(`⭐ <b>Bonus</b>: ${escapeHtml(bonus.join(", "))}`);
  }
  if (watch.length > 0) {
    lines.push(`⚠️ <b>Watch</b>: ${escapeHtml(watch.join(", "))}`);
  }
  if (other.length > 0) {
    lines.push(`ℹ️ <b>Why</b>: ${escapeHtml(other.join(", "))}`);
  }

  return lines.length > 0 ? lines : ["ℹ️ <b>Why</b>: no specific reason"];
}

function humanTrigger(trigger) {
  const text = String(trigger || "").trim();
  if (/^notify all products mode$/i.test(text)) {
    return "notify all";
  }

  const windowMatch = text.match(/^notify all products window\s+(.+)$/i);
  if (windowMatch) {
    return `notify all window ${windowMatch[1]}`;
  }

  const valueMatch = text.match(/^estimated value\s+(.+?)\s+>=\s+(.+)$/i);
  if (valueMatch) {
    return `value ${valueMatch[1]} >= ${valueMatch[2]}`;
  }

  const strictScoreMatch = text.match(/^strict score\s+(\S+)\s+>=\s+(\S+)/i);
  if (strictScoreMatch) {
    return `score ${strictScoreMatch[1]} >= ${strictScoreMatch[2]}`;
  }

  const scoreMatch = text.match(/^score\s+(\S+)\s+>=\s+(\S+)/i);
  if (scoreMatch) {
    return `score ${scoreMatch[1]} >= ${scoreMatch[2]}`;
  }

  return text;
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
    const estimatedValue = formatEuro(product.estimated_value_eur) || "not shown";
    const lines = [
      `🚨 <b>Vine match</b> · ${escapeHtml(product.section || "n/a")}`,
      escapeHtml(truncate(product.title || "Untitled product", 220)),
      "",
      `💰 <b>Value</b>: ${escapeHtml(estimatedValue)}`,
      `🎯 <b>Score</b>: ${escapeHtml(scoring.score)} · <b>Signals</b>: +${escapeHtml(scoring.positiveSignals || 0)} / -${escapeHtml(scoring.negativeSignals || 0)}`,
      "",
      ...reasonLines(reasons)
    ];

    if (triggers.length > 0) {
      lines.push(`🔔 <b>Trigger</b>: ${escapeHtml(compactItems(triggers.map(humanTrigger)))}`);
    }

    if (product.asin) {
      lines.push(`🆔 <b>ASIN</b>: ${escapeHtml(product.asin)}`);
    }

    return lines.join("\n");
  }

  formatProductPhotoCaption(product, scoring) {
    const estimatedValue = formatEuro(product.estimated_value_eur) || "not shown";
    const lines = [
      `🚨 <b>Vine match</b> · ${escapeHtml(product.section || "n/a")}`,
      escapeHtml(truncate(product.title || "Untitled product", 360)),
      "",
      `💰 <b>Value</b>: ${escapeHtml(estimatedValue)} · 🎯 <b>Score</b>: ${escapeHtml(scoring.score)} · +${escapeHtml(scoring.positiveSignals || 0)}/-${escapeHtml(scoring.negativeSignals || 0)}`
    ];

    const triggers =
      scoring.notificationTriggers && scoring.notificationTriggers.length > 0
        ? scoring.notificationTriggers.map(humanTrigger)
        : [];
    if (triggers.length > 0) {
      lines.push(`🔔 <b>Trigger</b>: ${escapeHtml(compactItems(triggers))}`);
    }

    if (product.asin) {
      lines.push(`🆔 <b>ASIN</b>: ${escapeHtml(product.asin)}`);
    }

    return lines.join("\n");
  }

  productReplyMarkup(product) {
    const vineUrl = product.section_url || product.url || "";
    if (!vineUrl) {
      return null;
    }
    return {
      inline_keyboard: [
        [
          {
            text: "Open Vine section",
            url: vineUrl
          }
        ]
      ]
    };
  }

  async sendProduct(product, scoring) {
    if (!this.enabled) {
      this.logger.warn("Telegram token/chat id missing; product notification skipped");
      return false;
    }

    const message = this.formatProductMessage(product, scoring);
    const replyMarkup = this.productReplyMarkup(product);

    if (product.image_url) {
      try {
        const caption = message.length <= 1024 ? message : this.formatProductPhotoCaption(product, scoring);
        const payload = {
          chat_id: this.chatId,
          photo: product.image_url,
          caption: truncate(caption, 1024),
          parse_mode: "HTML"
        };
        if (replyMarkup) {
          payload.reply_markup = replyMarkup;
        }
        await this.request("sendPhoto", payload);
        if (message.length > 1024) {
          const detailsPayload = {
            chat_id: this.chatId,
            text: truncate(message, 4096),
            disable_web_page_preview: true,
            parse_mode: "HTML"
          };
          if (replyMarkup) {
            detailsPayload.reply_markup = replyMarkup;
          }
          await this.request("sendMessage", detailsPayload);
        }
        return true;
      } catch (error) {
        this.logger.warn(`sendPhoto failed, falling back to sendMessage: ${error.message}`);
      }
    }

    const payload = {
      chat_id: this.chatId,
      text: truncate(message, 4096),
      disable_web_page_preview: false,
      parse_mode: "HTML"
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    await this.request("sendMessage", payload);
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
