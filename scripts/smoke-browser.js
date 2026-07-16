"use strict";

const { chromium } = require("playwright");

async function main() {
  const context = await chromium.launchPersistentContext("/tmp/vine-watcher-browser-smoke", {
    headless: false,
    args: ["--disable-dev-shm-usage", "--no-sandbox"]
  });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("data:text/html,<title>Vine Watcher smoke</title><main>ok</main>");
    const text = await page.locator("main").textContent();
    if (text !== "ok") {
      throw new Error(`Unexpected browser smoke content: ${text}`);
    }
    console.log("Chromium smoke test OK");
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
