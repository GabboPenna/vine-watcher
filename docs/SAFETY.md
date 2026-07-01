# Safety Policy

Vine Watcher is a read-only notification service.

It is designed to help you notice products in Amazon Vine, not to automate ordering or bypass Amazon controls.

## Allowed Behavior

- Open configured Amazon Vine section URLs.
- Read product cards from the page DOM.
- Read Vine detail metadata for products being evaluated for notification, with per-cycle limits.
- Store seen product metadata in a local SQLite database.
- Send Telegram notifications for products matching your scoring rules.
- Reuse a persistent Chromium profile created by manual login.

## Explicit Non-Goals

Vine Watcher must not:

- request Vine products
- click request, order, submit, checkout, or equivalent buttons
- bypass CAPTCHA, MFA, login, rate limits, or anti-abuse controls
- store your Amazon password
- export, import, or manipulate Amazon cookies explicitly
- crawl external Amazon product pages to enrich every product
- perform unbounded Vine detail crawling unrelated to notification decisions

## Manual Control

If Amazon asks for login, 2FA, CAPTCHA, or another manual check, the user must complete it manually.

The watcher can notify and back off, but it must not automate that flow.

## Contributions

Contributions must preserve this policy. Pull requests that add auto-requesting, checkout automation, CAPTCHA bypasses, or cookie export/import helpers will not be accepted.
