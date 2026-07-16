"use strict";

const http = require("http");

function jsonResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function textResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function isAuthorized(request, token) {
  if (!token) {
    return true;
  }

  const authHeader = request.headers.authorization || "";
  if (authHeader === `Bearer ${token}`) {
    return true;
  }

  try {
    const url = new URL(request.url, "http://localhost");
    return url.searchParams.get("token") === token;
  } catch (_error) {
    return false;
  }
}

function metricLine(name, value, help = "") {
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) ? numeric : 0;
  return `${help ? `# HELP ${name} ${help}\n# TYPE ${name} gauge\n` : ""}${name} ${safeValue}\n`;
}

function metricsText(stats, status) {
  const totals = stats.totals || {};
  const scanCycles = stats.scanCycles || {};
  const lastCycle = status.lastCycle || {};
  return [
    metricLine("vine_watcher_products_total", totals.total, "Saved products in the local database"),
    metricLine("vine_watcher_products_present", totals.present, "Products seen in the latest complete inventory cycle"),
    metricLine("vine_watcher_products_gone", totals.gone, "Products that disappeared from the latest inventory"),
    metricLine("vine_watcher_products_notified", totals.notified, "Products already notified"),
    metricLine("vine_watcher_products_reappeared", totals.reappeared, "Products that disappeared and later reappeared"),
    metricLine("vine_watcher_value_lookup_pending", totals.value_lookup_pending, "Products waiting for a Vine value"),
    metricLine("vine_watcher_scan_cycles_total", scanCycles.total, "Saved scan cycles"),
    metricLine("vine_watcher_scan_cycles_failed", scanCycles.failed, "Failed scan cycles"),
    metricLine("vine_watcher_last_cycle_scanned", lastCycle.scanned, "Products scanned in the latest cycle"),
    metricLine("vine_watcher_last_cycle_new", lastCycle.newProducts, "New products found in the latest cycle"),
    metricLine("vine_watcher_last_cycle_notified", lastCycle.notified, "Notifications sent in the latest cycle"),
    metricLine(
      "vine_watcher_last_cycle_success",
      status.lastCycle ? (lastCycle.success === false ? 0 : 1) : 0,
      "Whether the latest cycle succeeded"
    ),
    metricLine(
      "vine_watcher_last_success_age_seconds",
      status.lastSuccessfulCycleAt ? (Date.now() - status.lastSuccessfulCycleAt) / 1000 : -1,
      "Seconds since the latest successful scan cycle"
    ),
    metricLine("vine_watcher_last_cycle_dry_run_matches", lastCycle.dryRunMatches, "Dry-run matches in the latest cycle"),
    metricLine("vine_watcher_last_cycle_disappeared", lastCycle.disappearedProducts, "Products marked gone in the latest cycle"),
    metricLine(
      "vine_watcher_memory_process_tree_mb",
      status.memory && status.memory.processTreeRssMb,
      "Approximate watcher process tree RSS in MB"
    )
  ].join("");
}

function startHealthServer({ config, storage, getStatus, logger, version = "" }) {
  if (!config.healthServerEnabled) {
    return null;
  }

  const server = http.createServer((request, response) => {
    if (!isAuthorized(request, config.healthServerToken)) {
      jsonResponse(response, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const url = new URL(request.url, "http://localhost");
    const status = getStatus();
    const stats = storage.getStats();

    if (url.pathname === "/health") {
      const now = Date.now();
      const lastSuccessfulCycleAt = Number(status.lastSuccessfulCycleAt || 0);
      const successAgeMs = lastSuccessfulCycleAt ? now - lastSuccessfulCycleAt : null;
      const startupAgeMs = now - Number(status.startedAt || now);
      const fresh =
        successAgeMs !== null
          ? successAgeMs <= config.healthStaleAfterMs
          : startupAgeMs <= Math.max(config.healthStaleAfterMs, 60000);
      jsonResponse(response, fresh ? 200 : 503, {
        ok: fresh,
        degraded: Boolean(status.lastCycle && status.lastCycle.success === false),
        version,
        uptimeSeconds: Math.round(process.uptime()),
        lastCycle: status.lastCycle || null,
        lastSuccessfulCycleAt: lastSuccessfulCycleAt || null,
        successAgeSeconds: successAgeMs === null ? null : Math.round(successAgeMs / 1000),
        memory: status.memory || null,
        stats: stats.totals || {}
      });
      return;
    }

    if (url.pathname === "/last-cycle") {
      jsonResponse(response, 200, {
        ok: true,
        lastCycle: status.lastCycle || null,
        recentCycles: storage.recentScanCycles(10)
      });
      return;
    }

    if (url.pathname === "/latest-products") {
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));
      const mode = url.searchParams.get("mode") || "all";
      jsonResponse(response, 200, {
        ok: true,
        products: storage.recentProducts({ limit, mode })
      });
      return;
    }

    if (url.pathname === "/metrics") {
      textResponse(response, 200, metricsText(stats, status));
      return;
    }

    jsonResponse(response, 404, {
      ok: false,
      error: "not found",
      endpoints: ["/health", "/metrics", "/last-cycle", "/latest-products"]
    });
  });

  server.listen(config.healthServerPort, config.healthServerHost, () => {
    logger.info(`Health API listening on http://${config.healthServerHost}:${config.healthServerPort}`);
  });

  server.on("error", (error) => {
    logger.warn(`Health API failed: ${error.message}`);
  });

  return server;
}

module.exports = {
  startHealthServer
};
