import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const removedVerificationScripts = [
  "scripts/verify-repository-docs.mjs",
  "scripts/verify-package-metadata.mjs",
  "scripts/verify-github-config.mjs",
];
const staleReferencePattern = /verify-(?:repository-docs|package-metadata|github-config)/u;

for (const scriptPath of removedVerificationScripts) {
  assert.equal(existsSync(join(root, scriptPath)), false, `${scriptPath} must be removed`);
}

const trackedFiles = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/u)
  .filter(Boolean);

const staleReferenceFiles = trackedFiles.filter((filePath) => {
  const absolutePath = join(root, filePath);
  if (filePath === "scripts/check-verification-cleanup.mjs" || !existsSync(absolutePath)) {
    return false;
  }

  return staleReferencePattern.test(readFileSync(absolutePath, "utf8"));
});

assert.deepEqual(
  staleReferenceFiles,
  [],
  `Removed verify-* scripts must not be referenced outside this cleanup check: ${staleReferenceFiles.join(", ")}`,
);

console.log("Obsolete verification scripts and references are removed.");
