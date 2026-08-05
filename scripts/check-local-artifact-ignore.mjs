import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

function readText(path) {
  return readFileSync(join(root, path), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function assertGitignorePattern(pattern) {
  const gitignore = readText(".gitignore");
  assert.match(
    gitignore,
    new RegExp(`^${escapeRegExp(pattern)}$`, "mu"),
    `.gitignore must include a ${pattern} ignore pattern`,
  );
}

function assertIgnored(path) {
  const result = execFileSync("git", ["check-ignore", path], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(result, path, `${path} must be ignored by git`);
}

function assertNotIgnored(path) {
  try {
    execFileSync("git", ["check-ignore", path], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    assert.equal(error.status, 1, `${path} check-ignore should exit 1 when not ignored`);
    return;
  }

  assert.fail(`${path} must remain trackable and not be ignored by git`);
}

function assertNoTrackedLocalArtifacts() {
  const tracked = execFileSync(
    "git",
    ["ls-files", ".stepkit", ".claude", "skills-lock", "skills-lock.json", "agent/skills"],
    { cwd: root, encoding: "utf8" },
  )
    .split(/\r?\n/u)
    .filter(Boolean);

  assert.deepEqual(
    tracked,
    [],
    `Local agent/runtime artifacts must not be tracked: ${tracked.join(", ")}`,
  );
}

function assertPackageFilesExcludeLocalArtifacts() {
  const packageJsonPaths = ["package.json"];
  for (const directoryEntry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (directoryEntry.isDirectory()) {
      const packageJsonPath = `packages/${directoryEntry.name}/package.json`;
      if (existsSync(join(root, packageJsonPath))) {
        packageJsonPaths.push(packageJsonPath);
      }
    }
  }

  const localArtifactPatterns = [
    /^\.stepkit(?:\/|$)/u,
    /^\.claude(?:\/|$)/u,
    /^agent\/skills(?:\/|$)/u,
    /^skills-lock(?:\.json)?$/u,
  ];

  for (const packageJsonPath of packageJsonPaths) {
    const manifest = readJson(packageJsonPath);
    for (const fileEntry of manifest.files ?? []) {
      assert.ok(
        localArtifactPatterns.every((pattern) => !pattern.test(fileEntry)),
        `${packageJsonPath} files must not include local artifact path ${fileEntry}`,
      );
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

for (const pattern of [
  ".stepkit/",
  ".claude/",
  "agent/skills/",
  "skills-lock",
  "skills-lock.json",
]) {
  assertGitignorePattern(pattern);
}

for (const path of [
  ".stepkit/runs/example/events.jsonl",
  ".claude/settings.json",
  "agent/skills/example/SKILL.md",
  "skills-lock.json",
]) {
  assertIgnored(path);
}

assertNotIgnored("packages/cli/stepkit-skill/SKILL.md");
assertNoTrackedLocalArtifacts();
assertPackageFilesExcludeLocalArtifacts();

console.log("Local agent/runtime artifacts are ignored and excluded from tracking.");
