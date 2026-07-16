"use strict";

const http = require("http");

const port = Math.max(1, Number(process.env.HEALTH_SERVER_PORT) || 8765);
const token = process.env.HEALTH_SERVER_TOKEN || "";
const request = http.get(
  {
    host: "127.0.0.1",
    port,
    path: "/health",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeout: 4000
  },
  (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body = `${body}${chunk}`.slice(-16000);
    });
    response.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        process.exit(response.statusCode === 200 && parsed.ok ? 0 : 1);
      } catch (_error) {
        process.exit(1);
      }
    });
  }
);

request.on("timeout", () => request.destroy(new Error("health check timeout")));
request.on("error", () => process.exit(1));
