"use strict";

const { spawnSync } = require("node:child_process");
const { filesWithExtension, projectRoot } = require("./check-files");

function main() {
  const files = filesWithExtension(".js");
  let failed = false;

  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe"
    });

    if (result.status !== 0) {
      failed = true;
      process.stderr.write(`\nSyntax check failed: ${file}\n`);
      process.stderr.write(result.stderr || result.stdout || "");
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log(`JavaScript syntax OK (${files.length} files)`);
}

main();
