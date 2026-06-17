# Security Policy

## Supported Versions

Security fixes target the latest released version.

## Reporting a Vulnerability

Please do not post secrets, Telegram tokens, Amazon session data, cookies, screenshots with personal data, or private logs in public issues.

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not available, open a minimal public issue without sensitive details and ask for a private contact path.

## Sensitive Data

Never commit:

- `.env`
- Telegram bot tokens
- Amazon passwords
- browser profiles
- cookies
- SQLite runtime databases
- logs containing private data

The repository includes `npm run check:secrets` as a safety net, but it is not a substitute for careful review.
