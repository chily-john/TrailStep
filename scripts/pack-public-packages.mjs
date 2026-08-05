import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const packageManager = {
  command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  args: [],
  shell: process.platform === "win32",
};

const publicPackages = [
  { name: "@stepkit/core", directory: "packages/core" },
  { name: "@stepkit/authoring", directory: "packages/authoring" },
  { name: "@stepkit/cli", directory: "packages/cli", requiredFiles: ["stepkit-skill/SKILL.md"] },
  { name: "@stepkit/create-flows", directory: "packages/create-flows" },
];
const unpublishedPackageNames = ["@stepkit/testkit", "@stepkit/dashboard"];
const forbiddenPackedPathPatterns = [
  { label: ".stepkit", pattern: /^\.stepkit(?:\/|$)/u },
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
    ["packages/core", "packages/authoring", "packages/cli", "packages/create-flows"],
    "dry-run package directories must be the explicit initial public release set",
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
  assert.ok(
    existsSync(join(root, pkg.directory, normalized)),
    `${pkg.name} ${label} is missing ${normalized}; run pnpm build before pack dry-run`,
  );
}

function packDryRun(pkg) {
  const stdout = execFileSync(
    packageManager.command,
    [...packageManager.args, "pack", "--dry-run", "--json"],
    {
      cwd: join(root, pkg.directory),
      encoding: "utf8",
      shell: packageManager.shell,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const parsed = JSON.parse(stdout);
  const [packResult] = Array.isArray(parsed) ? parsed : [parsed];
  assert.ok(packResult, `${pkg.name} npm pack --dry-run returned no package data`);
  return packResult;
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
