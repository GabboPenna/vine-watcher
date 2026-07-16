"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const lockVersion = packageLock.packages && packageLock.packages[""] && packageLock.packages[""].version;

if (packageJson.version !== lockVersion) {
  throw new Error(`Version mismatch: package.json=${packageJson.version}, package-lock.json=${lockVersion}`);
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  const tagVersion = String(process.env.GITHUB_REF_NAME || "").replace(/^v/, "");
  if (tagVersion !== packageJson.version) {
    throw new Error(`Tag/version mismatch: tag=${tagVersion}, package.json=${packageJson.version}`);
  }
}

console.log(`Release metadata OK (${packageJson.version})`);
