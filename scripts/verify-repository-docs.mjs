import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function readText(path) {
  return readFileSync(join(root, path), "utf8");
}

function assertFile(path) {
  assert.ok(existsSync(join(root, path)), `Expected ${path} to exist`);
  return readText(path);
}

function assertIncludes(text, expected, path) {
  assert.ok(text.includes(expected), `Expected ${path} to include: ${expected}`);
}

function assertNotIncludes(text, forbidden, path) {
  assert.ok(!text.includes(forbidden), `Expected ${path} not to include: ${forbidden}`);
}

export function verifyRepositoryDocs() {
  const readme = assertFile("README.md");
  assertIncludes(
    readme,
    "StepKit is a durable, typed, observable workflow harness for coding agents.",
    "README.md",
  );
  assertIncludes(readme, "git@github-personal:chily-john/stepkit.git", "README.md");
  assert.match(
    readme,
    /command-backed local agents/iu,
    "Expected README.md to mention command-backed local agents",
  );
  assertIncludes(readme, "workflow-level `agents`", "README.md");
  assertIncludes(readme, "step-level `agent`", "README.md");
  assertIncludes(readme, "customProviders", "README.md");
  assertIncludes(readme, "agents.*.items", "README.md");
  assertIncludes(readme, "Implementation guidance lives in `.pi/rules/`", "README.md");

  const removedDirectionTerms = [
    "do" + "cs/",
    "publish-ready " + "scaf" + "fold",
    "currently " + "scaf" + "folded",
    "v" + "0",
  ];
  for (const forbidden of removedDirectionTerms) {
    assertNotIncludes(readme, forbidden, "README.md");
  }

  const packageReadmes = new Map([
    ["packages/core/README.md", assertFile("packages/core/README.md")],
    ["packages/sdk/README.md", assertFile("packages/sdk/README.md")],
    ["packages/cli/README.md", assertFile("packages/cli/README.md")],
    ["packages/dashboard/README.md", assertFile("packages/dashboard/README.md")],
    ["packages/testkit/README.md", assertFile("packages/testkit/README.md")],
  ]);

  assertIncludes(
    packageReadmes.get("packages/core/README.md") ?? "",
    "runWorkflow",
    "packages/core/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/sdk/README.md") ?? "",
    "defineWorkflow",
    "packages/sdk/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/cli/README.md") ?? "",
    "stepkit init",
    "packages/cli/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/cli/README.md") ?? "",
    "stepkit agents",
    "packages/cli/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/cli/README.md") ?? "",
    "stepkit list",
    "packages/cli/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/dashboard/README.md") ?? "",
    ".stepkit/runs",
    "packages/dashboard/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/testkit/README.md") ?? "",
    "workflow",
    "packages/testkit/README.md",
  );

  for (const [path, text] of packageReadmes) {
    for (const forbidden of ["do" + "cs/", "sc" + "affold", "v" + "0"]) {
      assertNotIncludes(text, forbidden, path);
    }
  }

  assertFile(".github/branch-protection.md");
}

verifyRepositoryDocs();
console.log("Repository documentation verified.");
