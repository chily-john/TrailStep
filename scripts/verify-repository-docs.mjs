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
  assertIncludes(readme, "automatic retry", "README.md");
  assertIncludes(readme, "safe pre-dispatch failures", "README.md");

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
    ["packages/authoring/README.md", assertFile("packages/authoring/README.md")],
    ["packages/cli/README.md", assertFile("packages/cli/README.md")],
    ["packages/dashboard/README.md", assertFile("packages/dashboard/README.md")],
    ["packages/testkit/README.md", assertFile("packages/testkit/README.md")],
    ["packages/create-flows/README.md", assertFile("packages/create-flows/README.md")],
  ]);

  const coreReadme = packageReadmes.get("packages/core/README.md") ?? "";
  const cliReadme = packageReadmes.get("packages/cli/README.md") ?? "";

  assertIncludes(coreReadme, "runWorkflow", "packages/core/README.md");
  for (const expected of [
    "automatic retry",
    "agent_provider_spawn_error",
    "agent_target_exhausted",
    "maxAttempts: 2",
    "step.attemptFailed",
    "workflow.retryStarted",
    "retryKind: \"automatic\"",
    "provider process failures",
    "provider output validation failures",
    "prompt rendering errors",
  ]) {
    assertIncludes(coreReadme, expected, "packages/core/README.md");
  }
  assertIncludes(
    packageReadmes.get("packages/authoring/README.md") ?? "",
    "defineWorkflow",
    "packages/authoring/README.md",
  );
  assertIncludes(cliReadme, "stepkit init", "packages/cli/README.md");
  assertIncludes(cliReadme, "stepkit agents", "packages/cli/README.md");
  assertIncludes(cliReadme, "stepkit workflows", "packages/cli/README.md");
  assertIncludes(cliReadme, "stepkit retry", "packages/cli/README.md");
  assertIncludes(cliReadme, "automatic retry", "packages/cli/README.md");
  assertIncludes(cliReadme, "manual retry", "packages/cli/README.md");
  assertIncludes(cliReadme, "Provider-level CLI `--resume`", "packages/cli/README.md");
  assertIncludes(
    packageReadmes.get("packages/dashboard/README.md") ?? "",
    ".trailstep/runs",
    "packages/dashboard/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/testkit/README.md") ?? "",
    "workflow",
    "packages/testkit/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/create-flows/README.md") ?? "",
    "stepkit add ./packages/create-flows/src/index.ts#takeItAway",
    "packages/create-flows/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/create-flows/README.md") ?? "",
    "`tsup` text loader",
    "packages/create-flows/README.md",
  );
  assertIncludes(
    packageReadmes.get("packages/create-flows/README.md") ?? "",
    "Do not blindly retry pre-fix corrupted take-it-away run artifacts",
    "packages/create-flows/README.md",
  );

  for (const [path, text] of packageReadmes) {
    for (const forbidden of ["do" + "cs/", "sc" + "affold", "v" + "0"]) {
      assertNotIncludes(text, forbidden, path);
    }
  }

  assertIncludes(
    assertFile(".pi/rules/packages/core/src/authoring/authoring.md"),
    "Built workflow packages must preserve the caller directory structure",
    ".pi/rules/packages/core/src/authoring/authoring.md",
  );
  assertIncludes(
    assertFile(".pi/rules/packages/create-flows/create-flows.md"),
    "no non-bundled output and no fragment-copy step are needed",
    ".pi/rules/packages/create-flows/create-flows.md",
  );

  assertFile(".github/branch-protection.md");
}

verifyRepositoryDocs();
console.log("Repository documentation verified.");
