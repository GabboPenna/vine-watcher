"use strict";

const { execFileSync, spawnSync } = require("node:child_process");

function gitFiles(pathspec) {
  const output = execFileSync("git", ["ls-files", pathspec], {
    encoding: "utf8"
  });
  return output.split(/\r?\n/).filter(Boolean);
}

function main() {
  const files = gitFiles("*.sh");
  let failed = false;

  for (const file of files) {
    const result = spawnSync("bash", ["-n", file], {
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
