"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules", "data", "logs", "test-results"]);

function gitTrackedFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.split(/\r?\n/).filter(Boolean);
  } catch (_error) {
    return null;
  }
}

function walk(relativeDirectory = "") {
  const absoluteDirectory = path.join(projectRoot, relativeDirectory);
  const output = [];
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const normalized = relativePath.replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        output.push(...walk(relativePath));
      }
      continue;
    }
    if (entry.isFile() && !entry.name.startsWith(".env") && normalized !== ".compose.env") {
      output.push(normalized);
    }
  }
  return output;
}

function projectFiles() {
  const tracked = gitTrackedFiles();
  return {
    files: tracked || walk(),
    fromGit: Boolean(tracked)
  };
}

function filesWithExtension(extension) {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  return projectFiles().files.filter((file) => file.toLowerCase().endsWith(normalizedExtension));
}

module.exports = {
  filesWithExtension,
  projectFiles,
  projectRoot
};
