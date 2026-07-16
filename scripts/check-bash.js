"use strict";

const { spawnSync } = require("node:child_process");
const { filesWithExtension, projectRoot } = require("./check-files");

function main() {
  const files = filesWithExtension(".sh");
  let failed = false;

  for (const file of files) {
    const result = spawnSync("bash", ["-n", file], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe"
    });

    if (result.error) {
      console.error("Bash is required for shell script validation.");
      console.error(result.error.message);
      process.exit(1);
    }

    if (result.status !== 0) {
      failed = true;
      process.stderr.write(`\nBash syntax check failed: ${file}\n`);
      process.stderr.write(result.stderr || result.stdout || "");
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log(`Bash syntax OK (${files.length} files)`);
}

main();
