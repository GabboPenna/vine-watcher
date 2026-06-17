# Contributing

Thanks for helping improve Vine Watcher.

## Ground Rules

Keep the project read-only and user-controlled.

Do not add:

- auto-requesting
- checkout automation
- CAPTCHA bypasses
- cookie export/import helpers
- credential storage

Read [docs/SAFETY.md](docs/SAFETY.md) before proposing behavior changes.

## Good Contributions

- safer Vine DOM selectors
- better scoring defaults
- clearer installation docs
- improved Docker/systemd behavior
- parser, scorer, storage, and Telegram formatting tests
- issue templates and CI improvements

## Local Validation

```bash
npm ci
npm run validate
```

If you do not have Node.js locally, use Docker:

```bash
docker run --rm -v "$PWD:/src:ro" -w /tmp/app node:22-bookworm \
  bash -lc "cp -a /src/. . && npm ci --loglevel=error && npm run validate"
```

## Pull Requests

- Keep changes focused.
- Do not commit `.env`, SQLite databases, Chromium profiles, logs, or tokens.
- Add tests when changing scoring, parsing, storage, or notification behavior.
- Update docs when changing install, Docker, or configuration behavior.
