"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { runCycle } = require("../src/index");
const { ProductStorage } = require("../src/storage");
const { ProductSender } = require("../src/product-sender");
const { ValueWorker } = require("../src/value-worker");
const { remainingScanDelayMs } = require("../src/scheduler");
const { FAST_PROFILE_ON, FAST_PROFILE_OFF, CONTROL_PROFILES } = require("../src/control-profiles");

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const section = { name: "Additional items", url: "https://www.amazon.it/vine/vine-items?queue=encore" };
const scoring = { score: 0, reasons: [], notificationTriggers: ["notify all products mode"] };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function product(n) {
  return { asin: `B0LAT${String(n).padStart(5, "0")}`, title: `Test product ${n}`, section: section.name,
    section_url: section.url, vine_recommendation_id: `test-recommendation-${n}`, estimated_value_eur: null };
}
function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vine-latency-"));
  const database = path.join(directory, "test.sqlite");
  const storage = new ProductStorage(database, logger);
  storage.init();
  const config = loadConfig({ sections: [section], sectionDelayMs: 0, notifyAllProducts: true,
    notifyAllProductsWindow: "", maxNotificationsPerCycle: 10, detailValueLookupMinIntervalMs: 0,
    detailValueLookupMaxPerCycle: 10, detailValueLookupEnabled: true, ...overrides });
  const sent = [], edits = [];
  const telegram = {
    async sendProduct(p) { sent.push(p); return { chatId: 123, messageId: sent.length, kind: "photo" }; },
    async editProductNotification(handle, p) { edits.push({ handle, product: p }); return true; }
  };
  const sender = new ProductSender({ storage, telegram, intervalMs: 0 });
  sender.beginCycle(config.maxNotificationsPerCycle);
  const scanner = { async scanSection() { return []; }, async enrichProductValue(p) { return { ...p, estimated_value_eur: 55 }; } };
  const worker = new ValueWorker({ storage, telegram: sender, getConfig: () => config, getScanner: () => scanner, logger });
  return { directory, database, storage, config, telegram, sender, scanner, worker, sent, edits,
    save(n) { return storage.saveProduct(product(n), scoring).product; },
    async close() { worker.paused = true; await sender.close(); await worker.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

async function testNewProductsDoNotWaitForValues() {
  const f = fixture();
  const gate = deferred(), started = deferred();
  try {
    const old = f.save(1);
    f.storage.markNotified(old.id, { messageId: 99, kind: "photo" });
    f.scanner.enrichProductValue = async (p) => { started.resolve(); await gate.promise; return { ...p, estimated_value_eur: 70 }; };
    const pending = f.worker.kick();
    assert.equal(f.worker.kick(), pending, "Only one value batch may be active");
    await started.promise;
    f.scanner.scanSection = async () => [product(1), product(2), product(3)];
    let timer;
    try {
      await Promise.race([
        runCycle({ ...f, telegram: f.sender, logger }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Notification waited for a value lookup")), 2000); })
      ]);
    } finally { clearTimeout(timer); }
    assert.deepEqual(f.sent.map((p) => p.asin), [product(2).asin, product(3).asin]);
    assert.equal(f.edits.length, 0);
    gate.resolve();
    await pending;
    assert.equal(f.edits.length, 1);
    assert.equal(f.storage.productById(old.id).estimated_value_eur, 70);
  } finally { gate.resolve(); await f.close(); }
}

async function testValueOnlyNotificationAndDuplicates() {
  const f = fixture({ notifyAllProducts: false, minScoreToNotify: 999, minValueToNotifyEur: 35 });
  try {
    f.scanner.scanSection = async () => [product(1)];
    const result = await runCycle({ ...f, telegram: f.sender, logger });
    assert.equal(result.notified, 0);
    await f.worker.kick();
    assert.equal(f.sent.length, 1, "Value-only match is delivered without another scan");
    assert.equal(f.sent[0].estimated_value_eur, 55);
    const saved = f.storage.findExisting(product(1));
    assert.equal(saved.notified, 1);
    assert.equal(saved.value_lookup_status, "found");
    assert.equal(saved.value_lookup_attempts, 1);
    await Promise.all([f.sender.sendProduct(saved, scoring), f.sender.sendProduct(saved, scoring)]);
    await runCycle({ ...f, telegram: f.sender, logger });
    assert.equal(f.sent.length, 1);
  } finally { await f.close(); }
}

async function testLookupCannotRestoreMissingInventory() {
  const f = fixture();
  const gate = deferred(), started = deferred();
  try {
    const saved = f.save(1);
    f.scanner.enrichProductValue = async (p) => { started.resolve(); await gate.promise; return { ...p, estimated_value_eur: 60 }; };
    const pending = f.worker.kick();
    await started.promise;
    f.storage.markMissingProducts("later-scan");
    const before = f.storage.productById(saved.id);
    gate.resolve(); await pending;
    const after = f.storage.productById(saved.id);
    assert.equal(after.present_now, 0);
    assert.equal(after.last_inventory_at, before.last_inventory_at);
    assert.equal(after.last_seen_at, before.last_seen_at);
    assert.equal(after.estimated_value_eur, 60);
    assert.equal(f.sent.length, 0);
  } finally { gate.resolve(); await f.close(); }
}

async function testDurableRetryAndSpacing() {
  const f = fixture({ detailValueLookupMinIntervalMs: 30000 });
  try {
    const first = f.save(1);
    f.scanner.enrichProductValue = async () => { throw new Error("HTTP 503"); };
    await f.worker.kick();
    const failed = f.storage.productById(first.id);
    assert.equal(failed.value_lookup_status, "error");
    assert.ok(Date.parse(failed.value_lookup_next_at) > Date.now());
    // A fresh worker (as after restart) still respects the persisted retry.
    const replacement = new ValueWorker({ storage: f.storage, telegram: f.sender, getConfig: () => f.config, getScanner: () => f.scanner, logger });
    await replacement.kick();
    assert.equal(replacement.stats.attempts, 0);
    await replacement.close();
    f.save(2);
    f.scanner.enrichProductValue = async (p) => ({ ...p, estimated_value_eur: 80 });
    await f.worker.kick();
    assert.equal(f.worker.stats.attempts, 1, "Global spacing spans batches");
    f.worker.rateState.lastAttemptAt = Date.now() - 30001;
    await f.worker.kick();
    assert.equal(f.worker.stats.attempts, 2);
    f.storage.db.prepare("UPDATE products SET value_lookup_next_at = NULL WHERE id = ?").run(first.id);
    f.worker.rateState.lastAttemptAt = Date.now() - 30001;
    await f.worker.kick();
    assert.equal(f.storage.productById(first.id).value_lookup_attempts, 2);
    assert.equal(f.storage.productById(first.id).estimated_value_eur, 80);
  } finally { await f.close(); }
}

async function testSharedNotificationBudget() {
  const f = fixture({ maxNotificationsPerCycle: 1, detailValueLookupMaxPerCycle: 1 });
  try {
    const a = f.save(1), b = f.save(2);
    await f.sender.sendProduct(a, scoring);
    await f.worker.kick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.storage.productById(b.id).estimated_value_eur, 55);
    assert.equal(f.storage.productById(b.id).notified, 0);
    f.sender.beginCycle(1);
    await f.sender.sendProduct(f.storage.productById(b.id), scoring);
    assert.equal(f.sent.length, 2);
  } finally { await f.close(); }
}

async function testNewNotificationsAheadOfQueuedEdits() {
  const f = fixture();
  const gate = deferred();
  try {
    const a = f.save(1), b = f.save(2);
    const events = [];
    f.telegram.sendProduct = async (p) => { events.push(`send:${p.id}`); if (p.id === a.id) await gate.promise; return { messageId: p.id }; };
    f.telegram.editProductNotification = async () => { events.push("edit"); return true; };
    const p1 = f.sender.sendProduct(a, scoring);
    const edit = f.sender.editProductNotification({}, a, scoring);
    const p2 = f.sender.sendProduct(b, scoring);
    const duplicate = f.sender.sendProduct(b, scoring);
    gate.resolve();
    await Promise.all([p1, edit, p2, duplicate]);
    assert.deepEqual(events, [`send:${a.id}`, `send:${b.id}`, "edit"]);
  } finally { gate.resolve(); await f.close(); }
}

async function testPauseAndDurableEdits() {
  const f = fixture();
  const gate = deferred(), started = deferred();
  try {
    const p = f.save(1);
    f.storage.markNotified(p.id, { messageId: 22, kind: "photo" });
    f.scanner.enrichProductValue = async (value) => { started.resolve(); await gate.promise; return { ...value, estimated_value_eur: 90 }; };
    const pending = f.worker.kick();
    await started.promise;
    const paused = f.worker.pause();
    gate.resolve(); await pending; await paused;
    assert.equal(f.edits.length, 0);
    assert.equal(f.storage.productById(p.id).value_edit_pending, 1);
    f.worker.resume();
    f.telegram.editProductNotification = async () => { throw new Error("temporary failure"); };
    await f.worker.kick();
    assert.equal(f.storage.productById(p.id).value_edit_pending, 1);
    f.storage.db.prepare("UPDATE products SET value_edit_next_at = NULL WHERE id = ?").run(p.id);
    f.telegram.editProductNotification = async () => true;
    await f.worker.kick();
    assert.equal(f.storage.productById(p.id).value_edit_pending, 0);
    assert.equal(f.worker.stats.attempts, 1, "Editing must not repeat the value request");
  } finally { gate.resolve(); await f.close(); }
}

function testCadenceAndFastProfiles() {
  assert.equal(remainingScanDelayMs(20000, 4200), 15800);
  assert.equal(remainingScanDelayMs(8000, 4200), 3800);
  assert.equal(remainingScanDelayMs(8000, 12000), 0);
  assert.equal(remainingScanDelayMs(8000, 90000, 60000), 60000);
  assert.equal(remainingScanDelayMs(8000, -100), 8000);
  for (const profile of [FAST_PROFILE_ON, CONTROL_PROFILES.drop]) {
    assert.equal(profile.section_scan_concurrency, "2");
    assert.equal(profile.reuse_section_pages, "true");
  }
  assert.equal(FAST_PROFILE_OFF.section_scan_concurrency, "1");
  assert.equal(FAST_PROFILE_OFF.reuse_section_pages, "false");
}

async function testValueArrivesDuringTelegramSend() {
  const f = fixture();
  const gate = deferred();
  try {
    const p = f.save(1);
    f.telegram.sendProduct = async () => { await gate.promise; return { messageId: 42, kind: "photo" }; };
    const sending = f.sender.sendProduct(p, scoring);
    f.storage.updateProductValue(p.id, 75);
    gate.resolve(); await sending;
    assert.equal(f.storage.productById(p.id).value_edit_pending, 1);
    // Completing an existing edit does not require another Amazon detail request.
    f.config.detailValueLookupEnabled = false;
    await f.worker.kick();
    assert.equal(f.edits[0].product.estimated_value_eur, 75);
    assert.equal(f.edits[0].handle.messageId, 42);
    assert.equal(f.worker.stats.attempts, 0);
  } finally { gate.resolve(); await f.close(); }
}

async function testShutdownPreservesQueuedEditAcrossDatabaseReopen() {
  const f = fixture();
  const gate = deferred();
  let reopened;
  try {
    const old = f.save(1), latest = f.save(2);
    f.storage.markNotified(old.id, { chatId: 123, messageId: 88, kind: "photo" });
    f.storage.updateProductValue(old.id, 90);
    f.telegram.sendProduct = async () => { await gate.promise; return { messageId: 89 }; };
    const sending = f.sender.sendProduct(latest, scoring);
    const batch = f.worker.kick([]);
    const paused = f.worker.pause();
    const closing = f.sender.close();
    gate.resolve();
    await Promise.all([sending, batch, paused, closing]);
    await f.worker.close();
    f.storage.close();
    reopened = new ProductStorage(f.database, logger);
    reopened.init();
    const pending = reopened.pendingValueEdits();
    assert.equal(pending.length, 1, "Cancelling an edit must preserve it across restart");
    assert.equal(pending[0].telegram_message_id, 88);
    assert.equal(reopened.productById(latest.id).notified, 1);
    const worker = new ValueWorker({ storage: reopened, telegram: f.telegram,
      getConfig: () => f.config, getScanner: () => f.scanner, logger });
    await worker.kick([]);
    await worker.close();
    assert.equal(reopened.pendingValueEdits().length, 0);
    assert.equal(f.edits.length, 1);
  } finally {
    gate.resolve();
    if (reopened) reopened.close();
    await f.close();
  }
}

async function testFailedSectionsDoNotStartValueLookups() {
  const f = fixture();
  try {
    f.save(1);
    await f.worker.kick(["another successful section"]);
    assert.equal(f.worker.stats.attempts, 0);
    await f.worker.kick([section.name]);
    assert.equal(f.worker.stats.attempts, 1);
  } finally { await f.close(); }
}

async function main() {
  for (const test of [testNewProductsDoNotWaitForValues, testValueOnlyNotificationAndDuplicates,
    testLookupCannotRestoreMissingInventory, testDurableRetryAndSpacing, testSharedNotificationBudget,
    testNewNotificationsAheadOfQueuedEdits, testPauseAndDurableEdits, testCadenceAndFastProfiles,
    testValueArrivesDuringTelegramSend, testShutdownPreservesQueuedEditAcrossDatabaseReopen,
    testFailedSectionsDoNotStartValueLookups]) {
    await test(); console.log(`OK ${test.name}`);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
