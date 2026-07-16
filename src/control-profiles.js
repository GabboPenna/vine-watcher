"use strict";

const { USER_SETTING_KEYS } = require("./runtime-config");

const FAST_PROFILE_ON = {
  panic_mode: "true",
  panic_until_ms: "0",
  panic_scan_interval_seconds: "5",
  panic_scan_jitter_seconds: "0",
  scan_interval_seconds: "10",
  scan_jitter_seconds: "0",
  page_timeout_seconds: "18",
  product_ready_timeout_seconds: "2",
  page_settle_seconds: "0",
  section_delay_seconds: "0"
};

const FAST_PROFILE_OFF = {
  panic_mode: "false",
  panic_until_ms: "0",
  panic_scan_interval_seconds: "10",
  panic_scan_jitter_seconds: "3",
  scan_interval_seconds: "30",
  scan_jitter_seconds: "10",
  page_timeout_seconds: "45",
  product_ready_timeout_seconds: "5",
  page_settle_seconds: "1",
  section_delay_seconds: "1"
};

const CONTROL_PROFILES = {
  conservative: {
    notify_all_products: "false",
    notify_all_products_window: "",
    min_score_to_notify: "20",
    min_value_to_notify_eur: "50",
    strict_notify_mode: "true",
    strict_min_positive_signals: "2",
    strict_max_negative_signals: "0",
    max_notifications_per_cycle: "5",
    adaptive_scan_enabled: "false",
    panic_mode: "false",
    panic_until_ms: "0",
    scan_interval_seconds: "45",
    scan_jitter_seconds: "15",
    page_timeout_seconds: "45",
    product_ready_timeout_seconds: "5",
    page_settle_seconds: "1",
    section_delay_seconds: "1",
    browser_memory_recycle_mb: "0"
  },
  balanced: {
    notify_all_products: "false",
    notify_all_products_window: "",
    min_score_to_notify: "5",
    min_value_to_notify_eur: "35",
    strict_notify_mode: "true",
    strict_min_positive_signals: "2",
    strict_max_negative_signals: "0",
    max_notifications_per_cycle: "10",
    adaptive_scan_enabled: "false",
    panic_mode: "false",
    panic_until_ms: "0",
    scan_interval_seconds: "30",
    scan_jitter_seconds: "10",
    page_timeout_seconds: "45",
    product_ready_timeout_seconds: "5",
    page_settle_seconds: "1",
    section_delay_seconds: "1",
    browser_memory_recycle_mb: "1500",
    browser_memory_recycle_cooldown_minutes: "10"
  },
  drop: {
    notify_all_products: "false",
    notify_all_products_window: "",
    min_score_to_notify: "5",
    min_value_to_notify_eur: "35",
    strict_notify_mode: "true",
    strict_min_positive_signals: "2",
    strict_max_negative_signals: "0",
    max_notifications_per_cycle: "15",
    adaptive_scan_enabled: "false",
    panic_mode: "true",
    panic_until_ms: "0",
    panic_scan_interval_seconds: "5",
    panic_scan_jitter_seconds: "0",
    scan_interval_seconds: "10",
    scan_jitter_seconds: "0",
    page_timeout_seconds: "18",
    product_ready_timeout_seconds: "2",
    page_settle_seconds: "0",
    section_delay_seconds: "0",
    browser_memory_recycle_mb: "1500",
    browser_memory_recycle_cooldown_minutes: "10"
  },
  "notify-all": {
    notify_all_products: "true",
    notify_all_products_window: "",
    min_score_to_notify: "5",
    min_value_to_notify_eur: "35",
    strict_notify_mode: "true",
    strict_min_positive_signals: "2",
    strict_max_negative_signals: "0",
    max_notifications_per_cycle: "20",
    adaptive_scan_enabled: "false",
    panic_mode: "false",
    panic_until_ms: "0",
    scan_interval_seconds: "30",
    scan_jitter_seconds: "10",
    page_timeout_seconds: "45",
    product_ready_timeout_seconds: "5",
    page_settle_seconds: "1",
    section_delay_seconds: "1",
    browser_memory_recycle_mb: "1500",
    browser_memory_recycle_cooldown_minutes: "10"
  }
};

const RESET_ALIASES = {
  all: USER_SETTING_KEYS,
  language: ["control_language"],
  lang: ["control_language"],
  notify_all: ["notify_all_products"],
  notify_all_window: ["notify_all_products_window"],
  window: ["notify_all_products_window"],
  score: ["min_score_to_notify"],
  min_score: ["min_score_to_notify"],
  value: ["min_value_to_notify_eur"],
  min_value: ["min_value_to_notify_eur"],
  strict: ["strict_notify_mode"],
  strict_signals: ["strict_min_positive_signals", "strict_max_negative_signals"],
  max_notifications: ["max_notifications_per_cycle"],
  panic: ["panic_mode", "panic_until_ms"],
  panic_interval: ["panic_scan_interval_seconds", "panic_scan_jitter_seconds"],
  scan_interval: ["scan_interval_seconds", "scan_jitter_seconds"],
  adaptive: [
    "adaptive_scan_enabled",
    "adaptive_idle_after_cycles",
    "adaptive_idle_interval_seconds",
    "adaptive_active_cycles",
    "adaptive_active_interval_seconds",
    "adaptive_active_jitter_seconds"
  ],
  fast: Object.keys(FAST_PROFILE_ON)
};

const CALLBACK_COMMANDS = {
  "vw:fast:on": "/fast on",
  "vw:fast:off": "/fast off",
  "vw:adaptive:on": "/adaptive on",
  "vw:adaptive:off": "/adaptive off",
  "vw:adaptive:default": "/adaptive 4 45 4 12 2",
  "vw:notify_all:always": "/notify_all always",
  "vw:notify_all:on": "/notify_all on",
  "vw:notify_all:off": "/notify_all off",
  "vw:notify_all_window:off": "/notify_all_window off",
  "vw:panic:30": "/panic 30",
  "vw:panic:off": "/panic off",
  "vw:score:5": "/min_score 5",
  "vw:value:35": "/min_value 35",
  "vw:strict:on": "/strict on",
  "vw:strict:off": "/strict off",
  "vw:profile:balanced": "/profile balanced",
  "vw:profile:drop": "/profile drop",
  "vw:profile:notify-all": "/profile notify-all",
  "vw:lang:it": "/lang it",
  "vw:lang:en": "/lang en"
};

const PRODUCT_LIST_MODES = new Set(["all", "notified", "unnotified", "ignored", "present", "gone", "reappeared", "top"]);

module.exports = {
  CALLBACK_COMMANDS,
  CONTROL_PROFILES,
  FAST_PROFILE_OFF,
  FAST_PROFILE_ON,
  PRODUCT_LIST_MODES,
  RESET_ALIASES
};
