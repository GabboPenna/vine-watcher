"use strict";

const { sleep } = require("./utils");

// One outbound product operation at a time, with new notifications ahead of
// cosmetic edits. Re-read persisted notification state immediately before send.
class ProductSender {
  constructor({ telegram, storage, intervalMs = 1000 }) {
    Object.assign(this, { telegram, storage, intervalMs });
    this.queue = [];
    this.pending = null;
    this.closed = false;
    this.remaining = 0;
    this.lastSentAt = 0;
  }

  beginCycle(limit) { this.remaining = Math.max(0, Number(limit) || 0); }

  enqueue(kind, args) {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, args, resolve, reject });
      this.start();
    });
  }

  sendProduct(product, scoring) { return this.enqueue("send", [product, scoring]); }
  editProductNotification(handle, product, scoring) { return this.enqueue("edit", [handle, product, scoring]); }

  start() {
    if (this.pending) return;
    this.pending = this.drain().finally(() => {
      this.pending = null;
      if (this.queue.length && !this.closed) this.start();
    });
  }

  async drain() {
    while (this.queue.length && !this.closed) {
      const wait = Math.max(0, this.lastSentAt + this.intervalMs - Date.now());
      if (wait) await sleep(wait);
      if (this.closed) break;
      const firstSend = this.queue.findIndex((job) => job.kind === "send");
      const job = this.queue.splice(firstSend < 0 ? 0 : firstSend, 1)[0];
      try {
        if (job.kind === "send") {
          const [product, scoring] = job.args;
          const fresh = this.storage.productById(product.id);
          if (!fresh || fresh.notified || !fresh.present_now || this.remaining <= 0) {
            job.resolve(false);
            continue;
          }
          this.remaining -= 1;
          this.lastSentAt = Date.now();
          const notification = { ...product, ...fresh };
          const sent = await this.telegram.sendProduct(notification, scoring);
          if (sent) {
            const saved = this.storage.markNotified(fresh.id, sent);
            // A value lookup can finish while Telegram is accepting this message.
            if (Number(saved.estimated_value_eur) > 0 &&
                Number(saved.estimated_value_eur) !== Number(notification.estimated_value_eur)) {
              this.storage.updateProductValue(saved.id, saved.estimated_value_eur);
            }
          }
          job.resolve(sent);
        } else {
          this.lastSentAt = Date.now();
          job.resolve(await this.telegram.editProductNotification(...job.args));
        }
      } catch (error) { job.reject(error); }
    }
  }

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.resolve(false);
    if (this.pending) await this.pending;
  }
}

module.exports = { ProductSender };
