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

function assertIncludes(text, expected, message) {
  assert.ok(text.includes(expected), message);
}

export function verifyGithubConfig() {
  const codeowners = assertFile(".github/CODEOWNERS");
  assert.match(
    codeowners,
    /^\/\s+@chily-john\s*$/mu,
    "CODEOWNERS must assign the repository root to @chily-john",
  );

  const pullRequestTemplate = assertFile(".github/pull_request_template.md");
  for (const expectedChecklistItem of ["tests", "docs", "non-goals", "package/build impact"]) {
    assert.match(
      pullRequestTemplate.toLowerCase(),
      new RegExp(expectedChecklistItem.replace("/", "\\/"), "u"),
      `PR template must mention ${expectedChecklistItem}`,
    );
  }

  const ci = assertFile(".github/workflows/ci.yml");
  assertIncludes(ci, "name: CI", "CI workflow must have a readable name");
  assert.match(ci, /pull_request:/u, "CI workflow must run on pull requests");
  assert.match(ci, /push:[\s\S]*branches:[\s\S]*main/u, "CI workflow must run on pushes to main");
  assert.match(ci, /node-version:\s*24/u, "CI workflow must use Node 24");
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm build",
  ]) {
    assertIncludes(ci, command, `CI workflow must run ${command}`);
  }

  const release = assertFile(".github/workflows/release.yml");
  assertIncludes(release, "name: Release", "Release workflow must have a readable name");
  assert.match(release, /workflow_dispatch:/u, "Release workflow must be manually triggered");
  assert.doesNotMatch(release, /push:/u, "Release workflow must not run on every push by default");
  assert.match(release, /node-version:\s*24/u, "Release workflow must use Node 24");
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm test",
    "pnpm build",
    "changesets/action",
  ]) {
    assertIncludes(release, command, `Release workflow must include ${command}`);
  }
  assertIncludes(
    release,
    "NPM_TOKEN",
    "Release workflow must reference the future NPM_TOKEN secret",
  );

  const dependencyReview = assertFile(".github/workflows/dependency-review.yml");
  assertIncludes(
    dependencyReview,
    "name: Dependency Review",
    "Dependency review workflow must have a readable name",
  );
  assert.match(
    dependencyReview,
    /pull_request:/u,
    "Dependency review workflow must run on pull requests",
  );
  assert.match(
    dependencyReview,
    /actions\/dependency-review-action/u,
    "Dependency review workflow must use GitHub's dependency review action",
  );

  const branchProtection = assertFile(".github/branch-protection.md");
  assert.match(
    branchProtection,
    /branch protection/i,
    "Branch protection requirements must be documented separately",
  );
  assert.match(
    branchProtection,
    /not enforced by workflow yaml/i,
    "Branch protection docs must not claim YAML enforcement",
  );
}

verifyGithubConfig();
console.log("GitHub repository configuration verified.");
