import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

type PublicPackage = { name: string; directory: string; requiredFiles?: string[] };

type Manifest = {
  name?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  files?: string[];
  main?: string;
  types?: string;
  bin?: Record<string, string>;
};

type PackResult = { name: string; files?: { path: string }[] };

const packCommand =
  process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm pack --dry-run --json"] }
    : { command: "pnpm", args: ["pack", "--dry-run", "--json"] };

const publicPackages: PublicPackage[] = [
  { name: "@trailstep/core", directory: "packages/core" },
  { name: "@trailstep/authoring", directory: "packages/authoring" },
  {
    name: "@trailstep/cli",
    directory: "packages/cli",
    requiredFiles: ["trailstep-skill/SKILL.md", "trailstep-authoring-skill/SKILL.md"],
  },
  { name: "@trailstep/mcp", directory: "packages/mcp" },
  { name: "@trailstep/create-flows", directory: "packages/create-flows" },
  { name: "@trailstep/sub-agents", directory: "packages/sub-agents" },
  { name: "@trailstep/provider-claude", directory: "packages/provider-claude" },
  { name: "@trailstep/provider-codex", directory: "packages/provider-codex" },
  { name: "@trailstep/provider-gemini", directory: "packages/provider-gemini" },
  { name: "@trailstep/provider-pi", directory: "packages/provider-pi" },
];
const unpublishedPackageNames = ["@trailstep/trailtest", "@trailstep/dashboard"];
const forbiddenPackedPathPatterns = [
  { label: ".trailstep", pattern: /^\.trailstep(?:\/|$)/u },
  { label: ".claude", pattern: /^\.claude(?:\/|$)/u },
  { label: "agent/skills", pattern: /^agent\/skills(?:\/|$)/u },
  { label: "skills-lock", pattern: /^skills-lock(?:\.json)?$/u },
  { label: "node_modules", pattern: /(?:^|\/)node_modules(?:\/|$)/u },
  { label: "coverage", pattern: /(?:^|\/)coverage(?:\/|$)/u },
  { label: "turbo cache", pattern: /(?:^|\/)\.turbo(?:\/|$)/u },
];

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Manifest;
}

function assertRootCommand(): void {
  const rootManifest = readJson("package.json");
  assert.equal(
    rootManifest.scripts?.["pack:public:dry-run"],
    "node scripts/pack-public-packages.ts",
    "root package.json must expose pack:public:dry-run",
  );
}

function assertExplicitPackageSet(): void {
  assert.deepEqual(
    publicPackages.map((pkg) => pkg.directory),
    [
      "packages/core",
      "packages/authoring",
      "packages/cli",
      "packages/mcp",
      "packages/create-flows",
      "packages/sub-agents",
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

function assertPackageManifest(pkg: PublicPackage): Manifest {
  const manifest = readJson(`${pkg.directory}/package.json`);
  assert.equal(manifest.name, pkg.name, `${pkg.directory} must be ${pkg.name}`);
  assert.notEqual(manifest.private, true, `${pkg.name} must be publishable, not private`);
  const files = manifest.files;
  assert.ok(Array.isArray(files), `${pkg.name} must declare explicit files`);
  assert.ok(files.includes("dist"), `${pkg.name} must include dist in files`);
  assert.ok(files.includes("README.md"), `${pkg.name} must include README.md in files`);
  assert.ok(files.includes("LICENSE"), `${pkg.name} must include LICENSE in files`);

  assertBuiltEntry(pkg, manifest.main, "main");
  assertBuiltEntry(pkg, manifest.types, "types");
  for (const [binName, binPath] of Object.entries(manifest.bin ?? {})) {
    assertBuiltEntry(pkg, binPath, `bin ${binName}`);
  }

  return manifest;
}

function assertBuiltEntry(
  pkg: PublicPackage,
  manifestPath: string | undefined,
  label: string,
): void {
  if (manifestPath === undefined) {
    return;
  }
  const normalized = normalizePackagePath(manifestPath) as string;
  assert.ok(
    normalized.startsWith("dist/"),
    `${pkg.name} ${label} must point at a dist runtime entry`,
  );
  void pkg;
  void label;
}

function packDryRun(pkg: PublicPackage): PackResult {
  const stdout = execFileSync(packCommand.command, packCommand.args, {
    cwd: join(root, pkg.directory),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = parsePackJson(stdout);
  const [packResult] = Array.isArray(parsed) ? parsed : [parsed];
  assert.ok(packResult, `${pkg.name} npm pack --dry-run returned no package data`);
  return packResult as PackResult;
}

function parsePackJson(stdout: string): unknown {
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

function assertPackedContents(
  pkg: PublicPackage,
  manifest: Manifest,
  packResult: PackResult,
): void {
  assert.equal(packResult.name, pkg.name, `${pkg.name} dry-run packed the wrong package`);
  const files = new Set(
    (packResult.files ?? [])
      .map((file) => normalizePackagePath(file.path))
      .filter((path): path is string => Boolean(path)),
  );

  for (const requiredFile of [
    "README.md",
    "LICENSE",
    "package.json",
    normalizePackagePath(manifest.main),
    normalizePackagePath(manifest.types),
    ...Object.values(manifest.bin ?? {}).map(normalizePackagePath),
    ...(pkg.requiredFiles ?? []),
  ].filter((path): path is string => Boolean(path))) {
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

function normalizePackagePath(path: string | undefined): string | undefined {
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
