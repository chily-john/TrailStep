import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const packageDirectories = [
  "core",
  "authoring",
  "cli",
  "mcp",
  "create-flows",
  "sub-agents",
  "provider-claude",
  "provider-codex",
  "provider-gemini",
  "provider-pi",
  "trailtest",
  "dashboard",
];
const publishablePackageNames = [
  "@trailstep/core",
  "@trailstep/authoring",
  "@trailstep/cli",
  "@trailstep/mcp",
  "@trailstep/create-flows",
  "@trailstep/sub-agents",
  "@trailstep/provider-claude",
  "@trailstep/provider-codex",
  "@trailstep/provider-gemini",
  "@trailstep/provider-pi",
];
const unpublishedPackageNames = ["@trailstep/trailtest", "@trailstep/dashboard"];
const expectedRepository = {
  type: "git",
  url: "git+ssh://git@github.com/chily-john/trailstep.git",
};

const depFields = ["dependencies", "devDependencies", "peerDependencies"] as const;

type Manifest = {
  name: string;
  version?: string;
  private?: boolean;
  license?: string;
  scripts?: Record<string, string>;
  repository?: { type?: string; url?: string };
  bugs?: { url?: string };
  homepage?: string;
  publishConfig?: { access?: string };
  files?: string[];
  main?: string;
  types?: string;
  exports?: Record<string, { import?: string; types?: string }>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readJson<T = Manifest>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

function assertFile(path: string): void {
  assert.ok(existsSync(join(root, path)), `Expected ${path} to exist`);
}

function packageDirectoryFor(packageName: string): string {
  return packageName.replace("@trailstep/", "");
}

function expectedCaretPeerRange(
  manifestByName: Map<string, Manifest>,
  packageName: string,
): string {
  const version = manifestByName.get(packageName)?.version;
  assert.equal(typeof version, "string", `${packageName} must declare a version`);
  const declaredVersion = version ?? "";
  const [stableVersion = declaredVersion] = declaredVersion.split("-");
  assert.match(stableVersion, /^\d+\.\d+\.\d+$/u, `${packageName} must declare a stable version`);
  return `^${stableVersion}`;
}

function assertNoPostinstallScripts(packageManifests: Manifest[]): void {
  for (const manifest of packageManifests) {
    assert.equal(
      manifest.scripts?.postinstall,
      undefined,
      `${manifest.name} must not define a postinstall prompt`,
    );
  }
}

function assertPublicNpmMetadata(manifest: Manifest): void {
  assertPublicPackageVersion(manifest);
  assert.equal(manifest.license, "Apache-2.0", `${manifest.name} must use Apache-2.0`);
  assert.deepEqual(
    manifest.repository,
    expectedRepository,
    `${manifest.name} must expose repository metadata`,
  );
  assert.equal(
    manifest.bugs?.url,
    "https://github.com/chily-john/trailstep/issues",
    `${manifest.name} must expose bugs metadata`,
  );
  assert.equal(
    manifest.homepage,
    "https://github.com/chily-john/trailstep#readme",
    `${manifest.name} must expose homepage metadata`,
  );
  assert.equal(
    manifest.publishConfig?.access,
    "public",
    `${manifest.name} must publish with public access`,
  );
  const files = manifest.files;
  assert.ok(Array.isArray(files), `${manifest.name} must declare explicit files`);
  assert.ok(files.includes("dist"), `${manifest.name} must publish dist`);
  assert.ok(files.includes("README.md"), `${manifest.name} must publish README.md`);
  assert.ok(files.includes("LICENSE"), `${manifest.name} must publish LICENSE`);
  assert.equal(manifest.main, "./dist/index.js", `${manifest.name} must declare main`);
  assert.equal(manifest.types, "./dist/index.d.ts", `${manifest.name} must declare types`);
  assert.equal(
    manifest.exports?.["."]?.import,
    "./dist/index.js",
    `${manifest.name} must export ESM`,
  );
  assert.equal(
    manifest.exports?.["."]?.types,
    "./dist/index.d.ts",
    `${manifest.name} must export types`,
  );

  const directory = packageDirectoryFor(manifest.name);
  assertFile(`packages/${directory}/README.md`);
  assertFile(`packages/${directory}/LICENSE`);
}

function assertPublicPackageVersion(manifest: Manifest): void {
  const version = manifest.version;
  assert.equal(typeof version, "string", `${manifest.name} must declare a version`);
  const declaredVersion = version ?? "";
  assert.match(
    declaredVersion,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
    `${manifest.name} must declare a semver-compatible version`,
  );
  assert.notEqual(declaredVersion, "0.0.0", `${manifest.name} must not publish as 0.0.0`);
}

function verifyPublicPackageMetadata(): void {
  const rootPackage = readJson("package.json");
  const changesetConfig = readJson<{ ignore?: string[] }>(".changeset/config.json");
  const packageManifests = packageDirectories.map((directory) =>
    readJson(`packages/${directory}/package.json`),
  );
  const manifestByName = new Map(packageManifests.map((manifest) => [manifest.name, manifest]));

  assertNoPostinstallScripts([rootPackage, ...packageManifests]);

  const actualPublishablePackageNames = packageManifests
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => manifest.name)
    .sort();
  assert.deepEqual(
    actualPublishablePackageNames,
    [...publishablePackageNames].sort(),
    "publishable package set must match the public package set",
  );

  for (const packageName of publishablePackageNames) {
    const manifest = manifestByName.get(packageName);
    assert.ok(manifest, `${packageName} manifest must exist`);
    assertPublicNpmMetadata(manifest);
  }

  for (const packageName of unpublishedPackageNames) {
    const manifest = manifestByName.get(packageName);
    assert.ok(manifest, `${packageName} manifest must exist`);
    assert.equal(manifest.private, true, `${packageName} must be private`);
    assert.ok(
      changesetConfig.ignore?.includes(packageName),
      `${packageName} must be ignored by Changesets`,
    );
  }

  assert.equal(
    manifestByName.get("@trailstep/authoring")?.dependencies?.["@trailstep/core"],
    "workspace:*",
    "@trailstep/authoring must keep @trailstep/core as a workspace dependency",
  );
  assert.equal(
    manifestByName.get("@trailstep/authoring")?.peerDependencies?.["@trailstep/core"],
    expectedCaretPeerRange(manifestByName, "@trailstep/core"),
    "@trailstep/authoring must declare peer compatibility with the current @trailstep/core version",
  );
  assert.equal(
    manifestByName.get("@trailstep/cli")?.dependencies?.["@trailstep/core"],
    "workspace:*",
    "@trailstep/cli must keep @trailstep/core as a workspace dependency",
  );
  assert.equal(
    manifestByName.get("@trailstep/cli")?.peerDependencies?.["@trailstep/core"],
    expectedCaretPeerRange(manifestByName, "@trailstep/core"),
    "@trailstep/cli must declare peer compatibility with the current @trailstep/core version",
  );
  assert.equal(
    manifestByName.get("@trailstep/create-flows")?.dependencies?.["@trailstep/authoring"],
    "workspace:*",
    "@trailstep/create-flows must keep @trailstep/authoring as a workspace dependency",
  );
  assert.equal(
    manifestByName.get("@trailstep/create-flows")?.peerDependencies?.["@trailstep/authoring"],
    expectedCaretPeerRange(manifestByName, "@trailstep/authoring"),
    "@trailstep/create-flows must declare peer compatibility with the current @trailstep/authoring version",
  );
  assert.equal(
    manifestByName.get("@trailstep/sub-agents")?.dependencies?.["@trailstep/authoring"],
    "workspace:*",
    "@trailstep/sub-agents must keep @trailstep/authoring as a workspace dependency",
  );
  assert.equal(
    manifestByName.get("@trailstep/sub-agents")?.peerDependencies?.["@trailstep/authoring"],
    expectedCaretPeerRange(manifestByName, "@trailstep/authoring"),
    "@trailstep/sub-agents must declare peer compatibility with the current @trailstep/authoring version",
  );
  for (const skillDirectory of ["trailstep-skill", "trailstep-authoring-skill"]) {
    assert.ok(
      manifestByName.get("@trailstep/cli")?.files?.includes(skillDirectory),
      `@trailstep/cli must include ${skillDirectory} in published files`,
    );
  }

  for (const depField of depFields) {
    for (const [depName, depRange] of Object.entries(rootPackage[depField] ?? {})) {
      if (depName.startsWith("@trailstep/")) {
        assert.equal(
          depRange,
          "workspace:*",
          `root ${depField}[${depName}] must be workspace:* so version bumps never desync pnpm-lock.yaml from package.json (run pnpm install after any manifest change)`,
        );
      }
    }
  }
}

verifyPublicPackageMetadata();
console.log("Public package metadata verified.");
