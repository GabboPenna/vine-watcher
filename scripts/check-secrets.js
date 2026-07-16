"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { projectFiles, projectRoot } = require("./check-files");

const allowedDataFiles = new Set(["data/.gitkeep"]);

const patterns = [
  {
    name: "telegram bot token",
    regex: /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/
  },
  {
    name: "private key",
    regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/
  },
  {
    name: "GitHub token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/
  },
  {
    name: "AWS access key",
    regex: /\bAKIA[0-9A-Z]{16}\b/
  },
  {
    name: "Amazon cookie",
    regex: /\b(?:session-id|ubid-[a-z]{2}|x-main|at-main|sess-at-main|sst-main)=/i
  }
];

function isTextFile(file) {
  const buffer = fs.readFileSync(path.join(projectRoot, file));
  return !buffer.includes(0);
}

function isForbiddenTrackedPath(file) {
  const normalized = file.replace(/\\/g, "/");
  if (normalized === ".env.example") {
    return false;
  }
  if (path.basename(normalized).startsWith(".env")) {
    return true;
  }
  if (normalized.startsWith("data/") && !allowedDataFiles.has(normalized)) {
    return true;
  }
  return false;
}

function main() {
  const failures = [];
  const discovery = projectFiles();

  for (const file of discovery.files) {
    if (discovery.fromGit && isForbiddenTrackedPath(file)) {
      failures.push(`${file}: forbidden tracked runtime/private file`);
      continue;
    }

    if (!isTextFile(file)) {
      continue;
    }

    const text = fs.readFileSync(path.join(projectRoot, file), "utf8");
    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (match) {
        failures.push(`${file}: possible ${pattern.name}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("Secret hygiene check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("Secret hygiene OK");
}

main();
