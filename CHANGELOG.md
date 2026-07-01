# Changelog

All notable changes to Vine Watcher are documented here.

This project uses semantic versioning.

## Unreleased

## [0.6.2] - 2026-07-01

### Added

- Added `present`, `gone`, and `reappeared` product modes to Telegram `/latest` and `/replay`.
- Added `/replay present 20` as a quick way to resend products currently visible on Vine when they were already marked as notified in the local database.

## [0.6.1] - 2026-07-01

### Changed

- Product notifications that already match score or notify-all rules are now sent immediately and updated afterward if the Vine detail value lookup finds a tax value.

## [0.6.0] - 2026-07-01

### Added

- Product notifications now use an inline Telegram button for the Vine section instead of printing the full URL.
- Estimated value alerts can now use the read-only Vine detail `taxValue` field when the card does not expose a value.

### Changed

- Telegram product notifications now group keywords, brands, bonuses, triggers, score, and value into a shorter product-card layout.

## [0.5.4] - 2026-07-01

### Changed

- Telegram product notifications now render field labels in bold for better readability.

## [0.5.3] - 2026-07-01

### Changed

- Telegram product notifications now always show the visible Vine value/price field, or say when it is not visible on the Vine card.
- Product notification text is more compact while keeping score, signals, section, reasons, triggers, Vine section link, and ASIN.
- Long photo notifications now keep a short caption and send the full compact details as a follow-up message instead of losing detail to Telegram's caption limit.

## [0.5.2] - 2026-06-25

### Added

- Added `SECTION_HARD_TIMEOUT_SECONDS`, a section-level watchdog that closes stuck Chromium pages when a Vine section scan exceeds its hard deadline.

### Changed

- Scanner page closing now uses a bounded close helper so cleanup cannot hang indefinitely on stuck Chromium pages.

## [0.5.1] - 2026-06-25

### Added

- Added `SCANNER_TURBO_ONLY_DURING_ADAPTIVE_ACTIVE` to use parallel section scanning and reusable section pages only during adaptive active windows.

### Changed

- Idle adaptive cycles can now run with the lighter serial scanner while active drop windows still use the fast parallel scanner.

## [0.5.0] - 2026-06-25

### Added

- Added parallel Vine section scanning with `SECTION_SCAN_CONCURRENCY`.
- Added reusable Chromium section pages with `REUSE_SECTION_PAGES`.
- Added runtime overrides for section scan concurrency and reusable section pages.
- Added tests for parallel section processing and reusable scanner pages.

### Changed

- The cycle processor can now notify products from the first completed section without waiting for slower sections.
- Telegram `/config` now shows section concurrency and reusable page mode.

## [0.4.1] - 2026-06-23

### Added

- Added Telegram Control support for adaptive scan scheduling with `/adaptive on|off` and `/adaptive idleAfter idleSeconds activeCycles activeSeconds activeJitter`.
- Added inline Telegram menu buttons for adaptive scheduler on, off, and a practical smart preset.
- Added adaptive scheduler details to Telegram status, config, help, and README/configuration docs.

## [0.4.0] - 2026-06-23

### Added

- Added current inventory tracking for present, disappeared, and reappeared products.
- Added per-product diagnostic snapshots with notification triggers, blockers, first score, latest decision, and safe runtime config.
- Added external scoring rules through `SCORING_RULES_PATH` and `SCORING_RULES_JSON`, with JSON and simple YAML list support.
- Added adaptive scan scheduling with active/idle intervals.
- Added layout-health warnings when complete scan cycles keep finding too few products.
- Added `npm run dry-run:once` to run a real scan without sending Telegram product notifications.
- Added a local read-only health API with `/health`, `/metrics`, `/last-cycle`, and `/latest-products`.
- Added SQLite retention and vacuum maintenance settings.
- Added scanner fixture coverage for product normalization.

### Changed

- Polished Telegram Control diagnostic messages with clearer sections, scan-friendly product rows, and friendlier emoji labels.
- Updated Docker publishing to publish multi-arch release images for `linux/amd64` and `linux/arm64`.
- Bumped package version to `0.4.0`.

## [0.3.0] - 2026-06-23

### Changed

- Added `thread` and `wireless` to the default positive smart-home scoring keywords.
- Expanded default scoring for smart-home, Home Assistant, energy monitoring, network/camera gear, household appliances, and useful appliance accessories, including Italian and English terms.
- Products are now processed and notified immediately after each section scan, instead of waiting for all sections to finish.
- Bumped package version to `0.3.0`.

### Added

- Added `NOTIFY_ALL_PRODUCTS=true` to notify every unnotified product regardless of score filters.
- Added `NOTIFY_ALL_PRODUCTS_WINDOW=HH:MM-HH:MM` to schedule notify-all mode during a local daily time window.
- Added optional Telegram Control with `/help`, `/status`, `/config`, runtime filters, speed profiles, panic mode, and Italian/English command help.
- Added a Telegram native command menu and `/menu` inline button control panel for common runtime actions.
- Added a Telegram Control 24/7 notify-all action that enables notify-all mode and clears the scheduled notify-all window.
- Added `/dashboard`, `/latest`, `/why`, `/replay`, and `/profile` Telegram Control commands.
- Added scan-cycle history in SQLite for easier diagnostics.
- Added optional process-tree memory recycling with `BROWSER_MEMORY_RECYCLE_MB`.
- Made Telegram Control responses friendlier, clearer, and easier to scan with human-readable labels and lightweight emoji.
- Added scheduled Chromium context recycling with `BROWSER_RESTART_INTERVAL_MINUTES` to reduce long-running browser memory growth.

## [0.2.0] - 2026-06-17

### Changed

- Renamed the package identity from `vine-watcher-telegram` to `vine-watcher`.
- Unified Docker and systemd watcher startup through `scripts/run-service.sh`.
- Made Docker watcher runtime use headed Chromium inside Xvfb by default, matching the Debian service.
- Slimmed the README and moved detailed documentation into `docs/`.
- Reduced duplication between `.env.example` and `compose.env.example`.
- Added contributing, security, issue template, and Dependabot metadata.

## [0.1.4] - 2026-06-17

### Changed

- Ran the Debian systemd watcher in headed Chromium inside a virtual Xvfb display.
- Added `scripts/run-service.sh`.
- Updated Debian installer requirements for Xvfb runtime.

## [0.1.3] - 2026-06-17

### Changed

- Made session attention non-blocking with grace-window and backoff behavior.
- Reduced noisy npm install warnings in automated paths.

## [0.1.2] - 2026-06-17

### Added

- Released Docker image publishing through GitHub Actions.

## [0.1.1] - 2026-06-17

### Added

- Docker Compose stack and Docker Hub publishing workflow.

## [0.1.0] - 2026-06-17

### Added

- Initial Vine watcher with Playwright, SQLite, Telegram notifications, scoring, systemd service, and Debian installer.
