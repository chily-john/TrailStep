import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const packageDirectories = ["core", "authoring", "cli", "create-flows", "testkit", "dashboard"];
const publishablePackageNames = [
  "@trailstep/core",
  "@trailstep/authoring",
  "@trailstep/cli",
  "@trailstep/create-flows",
];
const unpublishedPackageNames = ["@trailstep/testkit", "@trailstep/dashboard"];
const expectedRepository = {
  type: "git",
  url: "git+ssh://git@github.com/chily-john/trailstep.git",
};

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function assertFile(path) {
  assert.ok(existsSync(join(root, path)), `Expected ${path} to exist`);
}

function packageDirectoryFor(packageName) {
  return packageName.replace("@trailstep/", "");
}

function assertNoPostinstallScripts(packageManifests) {
  for (const manifest of packageManifests) {
    assert.equal(
      manifest.scripts?.postinstall,
      undefined,
      `${manifest.name} must not define a postinstall prompt`,
    );
  }
}

function assertPublicNpmMetadata(manifest) {
  assert.equal(manifest.version, "0.1.0", `${manifest.name} must be versioned for 0.1.0`);
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
  assert.ok(Array.isArray(manifest.files), `${manifest.name} must declare explicit files`);
  assert.ok(manifest.files.includes("dist"), `${manifest.name} must publish dist`);
  assert.ok(manifest.files.includes("README.md"), `${manifest.name} must publish README.md`);
  assert.ok(manifest.files.includes("LICENSE"), `${manifest.name} must publish LICENSE`);
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

function verifyPublicPackageMetadata() {
  const rootPackage = readJson("package.json");
  const changesetConfig = readJson(".changeset/config.json");
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
    "publishable package set must match the initial public release set",
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
    "^0.1.0",
    "@trailstep/authoring must declare @trailstep/core 0.1 peer compatibility",
  );
  assert.equal(
    manifestByName.get("@trailstep/cli")?.dependencies?.["@trailstep/core"],
    "workspace:*",
    "@trailstep/cli must keep @trailstep/core as a workspace dependency",
  );
  assert.equal(
    manifestByName.get("@trailstep/cli")?.peerDependencies?.["@trailstep/core"],
    "^0.1.0",
    "@trailstep/cli must declare @trailstep/core 0.1 peer compatibility",
  );
  assert.equal(
    manifestByName.get("@trailstep/create-flows")?.dependencies?.["@trailstep/authoring"],
    "workspace:*",
    "@trailstep/create-flows must keep @trailstep/authoring as a workspace dependency",
  );
  assert.equal(
    manifestByName.get("@trailstep/create-flows")?.peerDependencies?.["@trailstep/authoring"],
    "^0.1.0",
    "@trailstep/create-flows must declare @trailstep/authoring 0.1 peer compatibility",
  );
  assert.ok(
    manifestByName.get("@trailstep/cli")?.files?.includes("trailstep-skill"),
    "@trailstep/cli must include trailstep-skill in published files",
  );
}

verifyPublicPackageMetadata();
console.log("Public package metadata verified.");
