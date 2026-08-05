import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const docPaths = [
  "README.md",
  "packages/core/README.md",
  "packages/authoring/README.md",
  "packages/cli/README.md",
  "packages/create-flows/README.md",
  "packages/testkit/README.md",
  "packages/dashboard/README.md",
];

const publicPackages = [
  "@stepkit/core",
  "@stepkit/authoring",
  "@stepkit/cli",
  "@stepkit/create-flows",
];
const unpublishedPackages = ["@stepkit/testkit", "@stepkit/dashboard"];
const staleVerificationScripts = [
  "verify-repository-docs",
  "verify-package-metadata",
  "verify-github-config",
];
const hiddenContextMarkers = [".pi/rules", "AGENTS.md", "CLAUDE.md"];

function readDoc(path) {
  return readFileSync(join(root, path), "utf8");
}

function assertIncludes(text, expected, label) {
  assert.ok(text.includes(expected), `${label} must include ${expected}`);
}

function assertMatches(text, pattern, label) {
  assert.match(text, pattern, label);
}

const docs = new Map(docPaths.map((path) => [path, readDoc(path)]));
const rootReadme = docs.get("README.md");

assertIncludes(
  rootReadme,
  "StepKit is a durable, typed, observable workflow harness for coding agents.",
  "Root README",
);

for (const packageName of publicPackages) {
  assertIncludes(rootReadme, packageName, "Root README public package set");
  assertMatches(
    rootReadme,
    new RegExp(`pnpm add(?: -D)? ${packageName.replace("/", "\\/")}`, "u"),
    `Root README install example for ${packageName}`,
  );
}
for (const packageName of unpublishedPackages) {
  assertIncludes(rootReadme, packageName, "Root README unpublished package set");
  assertMatches(
    rootReadme,
    new RegExp(
      `${packageName.replace("/", "\\/")}[\\s\\S]{0,120}not part of the initial public publish set`,
      "u",
    ),
    `${packageName} must be marked unpublished`,
  );
}

const requiredRootTopics = [
  "stepkit init",
  "--install-skill",
  "--no-install-skill",
  "no npm postinstall prompt",
  "defineWorkflow({ start })",
  "step(...)",
  "done(...)",
  "workflow-level `agents`",
  "step-level `agent`",
  "JSON object inputs",
  "Direct refs",
  "Registered refs",
  "Bundle refs",
  "stepkit continue",
  "stepkit retry",
  ".stepkit/runs",
  "should not be manually mutated",
  "ignored by default",
  "pnpm check:public-packages",
  "pnpm run pack:public:dry-run",
  "node scripts/check-local-artifact-ignore.mjs",
  "pnpm check:verification-cleanup",
];
for (const topic of requiredRootTopics) {
  assertIncludes(rootReadme, topic, "Root README public topic coverage");
}

assert.doesNotMatch(
  rootReadme,
  /workflow-level\s+--resume/i,
  "Root README must not describe a workflow-level resume mechanism",
);

for (const [path, text] of docs) {
  for (const marker of hiddenContextMarkers) {
    assert.ok(!text.includes(marker), `${path} must not require hidden local context ${marker}`);
  }
  for (const scriptName of staleVerificationScripts) {
    assert.ok(!text.includes(scriptName), `${path} must not reference removed ${scriptName}`);
  }
}

for (const packageName of publicPackages) {
  const path = `packages/${packageName.replace("@stepkit/", "")}/README.md`;
  assertIncludes(docs.get(path), packageName, `${path} package identity`);
}

assertMatches(
  docs.get("packages/create-flows/README.md"),
  /public package of reusable, general-purpose StepKit workflows/u,
  "@stepkit/create-flows README must be public and reusable",
);
assert.doesNotMatch(
  docs.get("packages/create-flows/README.md"),
  /\b(my|personal|private|local-only)\b/iu,
  "@stepkit/create-flows README must not use personal/private/local-only framing",
);

for (const packageName of unpublishedPackages) {
  const path = `packages/${packageName.replace("@stepkit/", "")}/README.md`;
  assertIncludes(
    docs.get(path),
    "not part of the initial public publish set",
    `${path} unpublished status`,
  );
}

console.log("Public docs verified.");
