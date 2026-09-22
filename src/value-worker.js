"use strict";

const { scoreProduct } = require("./scorer");
const { notificationTriggers } = require("./notification-rules");

// Pending work and retry deadlines live on the product rows. Only one batch may
// use the browser's authenticated request context at a time.
class ValueWorker {
  constructor({ storage, telegram, getConfig, getScanner, logger, rateState = { lastAttemptAt: 0 } }) {
    Object.assign(this, { storage, telegram, getConfig, getScanner, logger, rateState });
    this.pending = null;
    this.paused = false;
    this.closed = false;
    this.stats = { attempts: 0, found: 0, failures: 0, notified: 0, edited: 0 };
  }

  kick(sectionNames = this.getConfig().sections.map((section) => section.name)) {
    if (this.pending || this.paused || this.closed) return this.pending;
    this.pending = this.runBatch(sectionNames)
      .catch((error) => this.logger.warn(`Value worker failed: ${error.message}`))
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  async pause() {
    this.paused = true;
    if (this.pending) await this.pending;
  }

  resume() {
    if (!this.closed) this.paused = false;
  }

  async close() {
    this.closed = true;
    await this.pause();
  }

  async runBatch(sectionNames) {
    const config = this.getConfig();
    const scanner = this.getScanner();
    if (this.paused || this.closed) return;
    const products = config.detailValueLookupEnabled && scanner
      ? this.storage.dueValueProducts(sectionNames, config.detailValueLookupMaxPerCycle) : [];
    for (const candidate of products) {
      if (this.paused || this.closed) break;
      const currentConfig = this.getConfig();
      if (!currentConfig.detailValueLookupEnabled) break;
      const now = Date.now();
      if (this.rateState.lastAttemptAt > 0 &&
          now - this.rateState.lastAttemptAt < currentConfig.detailValueLookupMinIntervalMs) break;
      const product = this.storage.productById(candidate.id);
      if (!product || !product.present_now || Number(product.estimated_value_eur) > 0) continue;
      this.rateState.lastAttemptAt = now;
      this.stats.attempts += 1;
      const attempts = Number(product.value_lookup_attempts || 0);
      const retryMs = Math.min(currentConfig.detailValueLookupRetryMaxMs,
        currentConfig.detailValueLookupRetryBaseMs * 2 ** Math.min(attempts, 8));
      let enriched;
      try {
        enriched = await scanner.enrichProductValue(product);
      } catch (error) {
        if (this.closed) break;
        this.stats.failures += 1;
        this.storage.recordValueLookupAttempt(product.id, {
          error: true, nextAt: new Date(Date.now() + retryMs).toISOString()
        });
        this.logger.warn(`Vine detail value lookup failed for product id=${product.id}: ${error.message}`);
        continue;
      }
      if (this.closed) break;
      const found = Number.isFinite(Number(enriched.estimated_value_eur)) && Number(enriched.estimated_value_eur) > 0;
      this.storage.recordValueLookupAttempt(product.id, {
        found, nextAt: found ? null : new Date(Date.now() + retryMs).toISOString()
      });
      if (!found) continue;
      this.stats.found += 1;
      // Never save an old inventory snapshot after a newer scan has completed.
      const fresh = this.storage.updateProductValue(product.id, enriched.estimated_value_eur);
      if (!fresh || this.paused || this.closed) continue;
      const scoring = scoreProduct(fresh, this.getConfig().keywords);
      const triggers = notificationTriggers(fresh, scoring, this.getConfig());
      if (!fresh.notified && fresh.present_now && triggers.length) {
        const sent = await this.telegram.sendProduct(fresh, { ...scoring, notificationTriggers: triggers });
        if (sent) {
          this.storage.markNotified(fresh.id, sent);
          this.stats.notified += 1;
        }
      }
    }
    // Persisted separately so recycling/restarting or a failed Telegram edit
    // cannot lose the caption update once the value itself has been saved.
    for (const product of this.storage.pendingValueEdits()) {
      if (this.paused || this.closed) break;
      const scoring = scoreProduct(product, this.getConfig().keywords);
      try {
        const edited = await this.telegram.editProductNotification({
          chatId: product.telegram_chat_id, messageId: product.telegram_message_id,
          kind: product.telegram_message_kind || "message"
        }, product, { ...scoring, notificationTriggers: notificationTriggers(product, scoring, this.getConfig()) });
        if (this.paused || this.closed) break;
        // Telegram also returns false when the message already contains the value.
        this.storage.recordValueEdit(product.id, true);
        if (edited !== false) this.stats.edited += 1;
      } catch (error) {
        if (this.paused || this.closed) break;
        this.storage.recordValueEdit(product.id, false);
        this.logger.warn(`Telegram value update failed for product id=${product.id}: ${error.message}`);
      }
    }
  }
}

module.exports = { ValueWorker };
