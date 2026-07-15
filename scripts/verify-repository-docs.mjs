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

function assertMentions(text, pattern, path, label) {
  assert.match(text, pattern, `Expected ${path} to mention ${label}`);
}

function assertRequiredText(textsByPath, requiredTexts) {
  const combinedText = [...textsByPath.values()].join("\n");
  const checkedPaths = [...textsByPath.keys()].join(", ");

  for (const expected of requiredTexts) {
    assert.ok(
      combinedText.includes(expected),
      `Expected one of ${checkedPaths} to include required direction text: ${expected}`,
    );
  }
}

function paragraphAround(text, index) {
  const start = text.lastIndexOf("\n\n", index);
  const end = text.indexOf("\n\n", index);

  return text.slice(start === -1 ? 0 : start + 2, end === -1 ? text.length : end);
}

function isHistoricalOrMigratedContext(paragraph) {
  return /historical|migrated-away|migrated away|obsolete|old direction|previous direction|no longer|replaced/i.test(
    paragraph,
  );
}

function assertNoCurrentDirectionText(textsByPath, forbiddenTexts) {
  for (const [path, text] of textsByPath) {
    for (const forbidden of forbiddenTexts) {
      let index = text.indexOf(forbidden);

      while (index !== -1) {
        const paragraph = paragraphAround(text, index);
        assert.ok(
          isHistoricalOrMigratedContext(paragraph),
          `Expected ${path} not to preserve forbidden current direction text unless marked historical/migrated-away: ${forbidden}`,
        );
        index = text.indexOf(forbidden, index + forbidden.length);
      }
    }
  }
}

export function verifyRepositoryDocs() {
  const readme = assertFile("README.md");
  assertIncludes(
    readme,
    "StepKit is a durable, typed, observable workflow harness for coding agents.",
    "README.md",
  );
  assertIncludes(readme, "git@github-personal:chily-john/stepkit.git", "README.md");

  // docs/ is intentionally a small set of durable, direction-steering documents.
  // Implementation detail lives in .pi/rules/; GitHub/branch-protection admin
  // guidance lives in .github/branch-protection.md (see verify-github-config.mjs).
  const docs = new Map([
    ["docs/architecture.md", assertFile("docs/architecture.md")],
    ["docs/roadmap.md", assertFile("docs/roadmap.md")],
  ]);

  const directionDocs = new Map([
    ["README.md", readme],
    ["docs/architecture.md", docs.get("docs/architecture.md") ?? ""],
    ["docs/roadmap.md", docs.get("docs/roadmap.md") ?? ""],
  ]);

  assertRequiredText(directionDocs, [
    ".stepkit/config.json",
    "command-backed local agents",
    "workflow-level `agents`",
    "step-level `agent`",
    "workingAgents",
    "interactiveAgents",
    "`requirements` -> workflow-level `agents` plus step-level `agent`",
    "Claude SDK integration is no longer a core-owned adapter path",
    "provider-neutral command-agent execution seams",
  ]);

  assertNoCurrentDirectionText(directionDocs, [
    "internal, string-keyed agent adapter registry",
    "adapters are not separate packages",
    "agent-adapter seams",
  ]);

  const allDocs = [readme, ...docs.values()].join("\n");

  for (const expected of [
    "clean-slate",
    "separate from Workflower",
    "TypeScript is the first-class authoring/runtime language",
    "core",
    "sdk",
    "cli",
    "testkit",
    "dashboard",
    "Workflows, not individual steps, are public command/discovery units",
    "Step invocations should use typed object input",
    "Prompt rendering should be deterministic from step input",
    "Runtime state access belongs in orchestration/code steps, not hidden in prompt rendering",
    "Observability/dashboard should be considered early",
    "CLI/discovery/npm package distribution are expected primary integration paths",
  ]) {
    assertIncludes(allDocs, expected, "repository docs");
  }

  for (const [question, pattern] of [
    ["SDK overloads", /SDK overloads/i],
    ["agent abstraction", /agent abstraction/i],
    ["prompt syntax", /prompt syntax/i],
    ["human-in-the-loop details", /human-in-the-loop/i],
    ["runtime event log format", /runtime event log format/i],
    ["parallelization", /parallelization/i],
    ["workflow discovery shape", /workflow discovery shape/i],
    ["adapter strategy", /adapter strategy/i],
  ]) {
    assertMentions(allDocs, pattern, "repository docs", question);
  }

  const roadmap = docs.get("docs/roadmap.md") ?? "";
  assertIncludes(roadmap, "What's next", "docs/roadmap.md");

  const implementedPackageReadmes = new Map([
    ["packages/core/README.md", assertFile("packages/core/README.md")],
    ["packages/sdk/README.md", assertFile("packages/sdk/README.md")],
    ["packages/cli/README.md", assertFile("packages/cli/README.md")],
  ]);

  for (const [path, text] of implementedPackageReadmes) {
    assert.doesNotMatch(
      text,
      /scaffold only|scaffold package|placeholder-only/i,
      `${path} must describe implemented v0 behavior`,
    );
    assertIncludes(text, "v0", path);
  }

  assertIncludes(
    implementedPackageReadmes.get("packages/core/README.md") ?? "",
    "runWorkflow",
    "packages/core/README.md",
  );
  assertIncludes(
    implementedPackageReadmes.get("packages/sdk/README.md") ?? "",
    "defineWorkflow",
    "packages/sdk/README.md",
  );
  assertIncludes(
    implementedPackageReadmes.get("packages/cli/README.md") ?? "",
    "stepkit list",
    "packages/cli/README.md",
  );

  // GitHub-facing branch-protection guidance lives solely in
  // .github/branch-protection.md; verify-github-config.mjs asserts its content.
  assertFile(".github/branch-protection.md");
}

verifyRepositoryDocs();
console.log("Repository documentation verified.");
