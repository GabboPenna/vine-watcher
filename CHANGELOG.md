# Changelog

All notable changes to Vine Watcher are documented here.

This project uses semantic versioning.

## Unreleased

### Changed

- Added `thread` and `wireless` to the default positive smart-home scoring keywords.

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
