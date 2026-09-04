import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const packCommand =
  process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm pack --dry-run --json"] }
    : { command: "pnpm", args: ["pack", "--dry-run", "--json"] };

const publicPackages = [
  { name: "@trailstep/core", directory: "packages/core" },
  { name: "@trailstep/authoring", directory: "packages/authoring" },
  {
    name: "@trailstep/cli",
    directory: "packages/cli",
    requiredFiles: ["trailstep-skill/SKILL.md"],
  },
  { name: "@trailstep/create-flows", directory: "packages/create-flows" },
  { name: "@trailstep/provider-claude", directory: "packages/provider-claude" },
  { name: "@trailstep/provider-codex", directory: "packages/provider-codex" },
  { name: "@trailstep/provider-gemini", directory: "packages/provider-gemini" },
  { name: "@trailstep/provider-pi", directory: "packages/provider-pi" },
];
const unpublishedPackageNames = ["@trailstep/testkit", "@trailstep/dashboard"];
const forbiddenPackedPathPatterns = [
  { label: ".trailstep", pattern: /^\.trailstep(?:\/|$)/u },
  { label: ".claude", pattern: /^\.claude(?:\/|$)/u },
  { label: "agent/skills", pattern: /^agent\/skills(?:\/|$)/u },
  { label: "skills-lock", pattern: /^skills-lock(?:\.json)?$/u },
  { label: "node_modules", pattern: /(?:^|\/)node_modules(?:\/|$)/u },
  { label: "coverage", pattern: /(?:^|\/)coverage(?:\/|$)/u },
  { label: "turbo cache", pattern: /(?:^|\/)\.turbo(?:\/|$)/u },
];

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function assertRootCommand() {
  const rootManifest = readJson("package.json");
  assert.equal(
    rootManifest.scripts?.["pack:public:dry-run"],
    "node scripts/pack-public-packages.mjs",
    "root package.json must expose pack:public:dry-run",
  );
}

function assertExplicitPackageSet() {
  assert.deepEqual(
    publicPackages.map((pkg) => pkg.directory),
    [
      "packages/core",
      "packages/authoring",
      "packages/cli",
      "packages/create-flows",
      "packages/provider-claude",
      "packages/provider-codex",
      "packages/provider-gemini",
      "packages/provider-pi",
    ],
    "dry-run package directories must be the explicit public release set",
  );

  for (const packageName of unpublishedPackageNames) {
    assert.ok(
      !publicPackages.some((pkg) => pkg.name === packageName),
      `${packageName} must not be included in public pack dry-runs`,
    );
  }
}

function assertPackageManifest(pkg) {
  const manifest = readJson(`${pkg.directory}/package.json`);
  assert.equal(manifest.name, pkg.name, `${pkg.directory} must be ${pkg.name}`);
  assert.notEqual(manifest.private, true, `${pkg.name} must be publishable, not private`);
  assert.ok(Array.isArray(manifest.files), `${pkg.name} must declare explicit files`);
  assert.ok(manifest.files.includes("dist"), `${pkg.name} must include dist in files`);
  assert.ok(manifest.files.includes("README.md"), `${pkg.name} must include README.md in files`);
  assert.ok(manifest.files.includes("LICENSE"), `${pkg.name} must include LICENSE in files`);

  assertBuiltEntry(pkg, manifest.main, "main");
  assertBuiltEntry(pkg, manifest.types, "types");
  for (const [binName, binPath] of Object.entries(manifest.bin ?? {})) {
    assertBuiltEntry(pkg, binPath, `bin ${binName}`);
  }

  return manifest;
}

function assertBuiltEntry(pkg, manifestPath, label) {
  if (manifestPath === undefined) {
    return;
  }
  const normalized = normalizePackagePath(manifestPath);
  assert.ok(
    normalized.startsWith("dist/"),
    `${pkg.name} ${label} must point at a dist runtime entry`,
  );
  void pkg;
  void label;
}

function packDryRun(pkg) {
  const stdout = execFileSync(packCommand.command, packCommand.args, {
    cwd: join(root, pkg.directory),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = parsePackJson(stdout);
  const [packResult] = Array.isArray(parsed) ? parsed : [parsed];
  assert.ok(packResult, `${pkg.name} npm pack --dry-run returned no package data`);
  return packResult;
}

function parsePackJson(stdout) {
  const lines = stdout.trim().split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join("\n").trim();
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  assert.fail(`pnpm pack --dry-run --json did not emit parseable JSON:\n${stdout}`);
}

function assertPackedContents(pkg, manifest, packResult) {
  assert.equal(packResult.name, pkg.name, `${pkg.name} dry-run packed the wrong package`);
  const files = new Set(
    (packResult.files ?? []).map((file) => normalizePackagePath(file.path)).filter(Boolean),
  );

  for (const requiredFile of [
    "README.md",
    "LICENSE",
    "package.json",
    normalizePackagePath(manifest.main),
    normalizePackagePath(manifest.types),
    ...Object.values(manifest.bin ?? {}).map(normalizePackagePath),
    ...(pkg.requiredFiles ?? []),
  ].filter(Boolean)) {
    assert.ok(files.has(requiredFile), `${pkg.name} packed contents must include ${requiredFile}`);
  }

  for (const filePath of files) {
    for (const { label, pattern } of forbiddenPackedPathPatterns) {
      assert.ok(
        !pattern.test(filePath),
        `${pkg.name} tarball must not include ${label}: ${filePath}`,
      );
    }
  }
}

function normalizePackagePath(path) {
  return path
    ?.replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/^package\//u, "");
}

assertRootCommand();
assertExplicitPackageSet();

for (const pkg of publicPackages) {
  const manifest = assertPackageManifest(pkg);
  const packResult = packDryRun(pkg);
  assertPackedContents(pkg, manifest, packResult);
  console.log(`Verified npm pack dry-run for ${pkg.name}.`);
}

console.log("Public package pack dry-runs verified.");
