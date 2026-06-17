"use strict";

const { execFileSync, spawnSync } = require("node:child_process");

function gitFiles(pathspec) {
  const output = execFileSync("git", ["ls-files", pathspec], {
    encoding: "utf8"
  });
  return output.split(/\r?\n/).filter(Boolean);
}

function main() {
  const files = gitFiles("*.js");
  let failed = false;

  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
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
