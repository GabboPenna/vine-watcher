"use strict";

const { isTimeWindowActive, parseTimeWindow } = require("./time-window");

function formatEuro(value) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "n/a";
  }
  return `\u20ac${parsed.toFixed(2)}`;
}

function notifyAllProductsReason(config, nowMs = Date.now()) {
  if (config.notifyAllProducts) {
    return "notify all products mode";
  }

  if (config.notifyAllProductsWindow && isTimeWindowActive(config.notifyAllProductsWindow, config.timezoneId, nowMs)) {
    const window = parseTimeWindow(config.notifyAllProductsWindow);
    return `notify all products window ${window ? window.label : config.notifyAllProductsWindow}`;
  }

  return "";
}

function isNotifyAllProductsActive(config, nowMs = Date.now()) {
  return Boolean(notifyAllProductsReason(config, nowMs));
}

function notificationTriggers(product, scoring, config, nowMs = Date.now()) {
  const triggers = [];

  const notifyAllReason = notifyAllProductsReason(config, nowMs);
  if (notifyAllReason) {
    triggers.push(notifyAllReason);
    return triggers;
  }

  const estimatedValue =
    product.estimated_value_eur === null ||
    product.estimated_value_eur === undefined ||
    product.estimated_value_eur === ""
      ? Number.NaN
      : Number(product.estimated_value_eur);
  const valueTrigger =
    config.minValueToNotifyEur > 0 &&
    Number.isFinite(estimatedValue) &&
    estimatedValue >= config.minValueToNotifyEur;

  if (valueTrigger) {
    triggers.push(`estimated value ${formatEuro(estimatedValue)} >= ${formatEuro(config.minValueToNotifyEur)}`);
  }

  if (scoring.score >= config.minScoreToNotify) {
    if (!config.strictNotifyMode) {
      triggers.push(`score ${scoring.score} >= ${config.minScoreToNotify}`);
    } else if (
      scoring.positiveSignals >= config.strictMinPositiveSignals &&
      scoring.negativeSignals <= config.strictMaxNegativeSignals
    ) {
      triggers.push(
        `strict score ${scoring.score} >= ${config.minScoreToNotify} ` +
          `(${scoring.positiveSignals} positive, ${scoring.negativeSignals} negative)`
      );
    }
  }

  return triggers;
}

function notificationBlockers(product, scoring, config, alreadyNotified = false, nowMs = Date.now()) {
  const blockers = [];

  if (alreadyNotified) {
    blockers.push("already notified");
  }

  if (config.notifyAllProductsWindow && !notifyAllProductsReason(config, nowMs)) {
    blockers.push(`notify-all window ${config.notifyAllProductsWindow} is not active now`);
  }

  const estimatedValue =
    product.estimated_value_eur === null ||
    product.estimated_value_eur === undefined ||
    product.estimated_value_eur === ""
      ? Number.NaN
      : Number(product.estimated_value_eur);

  if (config.minValueToNotifyEur > 0) {
    if (!Number.isFinite(estimatedValue)) {
      blockers.push(`estimated value is unavailable; value trigger needs ${formatEuro(config.minValueToNotifyEur)}`);
    } else if (estimatedValue < config.minValueToNotifyEur) {
      blockers.push(`estimated value ${formatEuro(estimatedValue)} < ${formatEuro(config.minValueToNotifyEur)}`);
    }
  }

  if (scoring.score < config.minScoreToNotify) {
    blockers.push(`score ${scoring.score} < ${config.minScoreToNotify}`);
  } else if (
    config.strictNotifyMode &&
    (scoring.positiveSignals < config.strictMinPositiveSignals ||
      scoring.negativeSignals > config.strictMaxNegativeSignals)
  ) {
    blockers.push(
      `strict mode needs ${config.strictMinPositiveSignals}+ positive and ` +
        `${config.strictMaxNegativeSignals} max negative signals; got ` +
        `${scoring.positiveSignals} positive and ${scoring.negativeSignals} negative`
    );
  }

  if (blockers.length === 0) {
    blockers.push("no blockers");
  }

  return blockers;
}

module.exports = {
  formatEuro,
  isNotifyAllProductsActive,
  notificationBlockers,
  notificationTriggers,
  notifyAllProductsReason
};
