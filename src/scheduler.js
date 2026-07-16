"use strict";

const { delayWithJitter } = require("./utils");

function isPanicActive(config, now = Date.now()) {
  return Boolean(config.panicMode || (config.panicUntilMs && now < config.panicUntilMs));
}

function memoryRecycleThresholdMb(config, baselineMb = 0) {
  const configured = Math.max(0, Number(config.browserMemoryRecycleMb || 0));
  const baseline = Math.max(0, Number(baselineMb || 0));
  const minGrowth = Math.max(0, Number(config.browserMemoryRecycleMinGrowthMb || 0));
  return Math.max(configured, baseline + minGrowth);
}

function nextScanDelayMs(config, adaptiveState = null) {
  if (isPanicActive(config)) {
    return delayWithJitter(config.panicScanIntervalSeconds, config.panicScanJitterSeconds);
  }
  if (config.adaptiveScanEnabled && adaptiveState) {
    if (adaptiveState.activeCyclesRemaining > 0) {
      return delayWithJitter(config.adaptiveActiveIntervalSeconds, config.adaptiveActiveJitterSeconds);
    }
    if (adaptiveState.idleCycles >= config.adaptiveIdleAfterCycles) {
      return delayWithJitter(config.adaptiveIdleIntervalSeconds, config.scanJitterSeconds);
    }
  }
  return delayWithJitter(config.scanIntervalSeconds, config.scanJitterSeconds);
}

function nextScanReason(config, adaptiveState = null, overrideReason = "") {
  if (overrideReason) {
    return overrideReason;
  }
  if (isPanicActive(config)) {
    return "panic mode";
  }
  if (config.adaptiveScanEnabled && adaptiveState) {
    if (adaptiveState.activeCyclesRemaining > 0) {
      return "adaptive active";
    }
    if (adaptiveState.idleCycles >= config.adaptiveIdleAfterCycles) {
      return "adaptive idle";
    }
  }
  return "";
}

function updateAdaptiveState(adaptiveState, summary, config) {
  if (!config.adaptiveScanEnabled) {
    adaptiveState.idleCycles = 0;
    adaptiveState.activeCyclesRemaining = 0;
    adaptiveState.lastReason = "";
    return adaptiveState;
  }

  const movement =
    Number(summary.newProducts || 0) > 0 ||
    Number(summary.notified || 0) > 0 ||
    Number(summary.disappearedProducts || 0) > 0;
  if (movement) {
    adaptiveState.idleCycles = 0;
    adaptiveState.activeCyclesRemaining = config.adaptiveActiveCycles;
    adaptiveState.lastReason = "movement";
    return adaptiveState;
  }

  adaptiveState.idleCycles += 1;
  adaptiveState.activeCyclesRemaining = Math.max(0, adaptiveState.activeCyclesRemaining - 1);
  adaptiveState.lastReason =
    adaptiveState.idleCycles >= config.adaptiveIdleAfterCycles ? "idle" : "normal";
  return adaptiveState;
}

function isAdaptiveActiveCycle(config, adaptiveState = null) {
  return Boolean(config.adaptiveScanEnabled && adaptiveState && adaptiveState.activeCyclesRemaining > 0);
}

function scannerConfigForCycle(config, adaptiveState = null) {
  const adaptiveActive = isAdaptiveActiveCycle(config, adaptiveState);
  if (!config.scannerTurboOnlyDuringAdaptiveActive || adaptiveActive) {
    return { config, adaptiveActive, turboEnabled: true };
  }
  return {
    config: {
      ...config,
      sectionScanConcurrency: 1,
      reuseSectionPages: false
    },
    adaptiveActive,
    turboEnabled: false
  };
}

module.exports = {
  isAdaptiveActiveCycle,
  isPanicActive,
  memoryRecycleThresholdMb,
  nextScanDelayMs,
  nextScanReason,
  scannerConfigForCycle,
  updateAdaptiveState
};
