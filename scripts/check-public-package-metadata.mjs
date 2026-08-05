import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const packageDirectories = ["core", "authoring", "cli", "create-flows", "testkit", "dashboard"];
const publishablePackageNames = [
  "@stepkit/core",
  "@stepkit/authoring",
  "@stepkit/cli",
  "@stepkit/create-flows",
];
const unpublishedPackageNames = ["@stepkit/testkit", "@stepkit/dashboard"];
const expectedRepository = {
  type: "git",
  url: "git+ssh://git@github.com/chily-john/stepkit.git",
};

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function assertFile(path) {
  assert.ok(existsSync(join(root, path)), `Expected ${path} to exist`);
}

function packageDirectoryFor(packageName) {
  return packageName.replace("@stepkit/", "");
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
    "https://github.com/chily-john/stepkit/issues",
    `${manifest.name} must expose bugs metadata`,
  );
  assert.equal(
    manifest.homepage,
    "https://github.com/chily-john/stepkit#readme",
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
    manifestByName.get("@stepkit/authoring")?.dependencies?.["@stepkit/core"],
    "workspace:*",
    "@stepkit/authoring must keep @stepkit/core as a workspace dependency",
  );
  assert.equal(
    manifestByName.get("@stepkit/authoring")?.peerDependencies?.["@stepkit/core"],
    "^0.1.0",
    "@stepkit/authoring must declare @stepkit/core 0.1 peer compatibility",
  );
  assert.equal(
    manifestByName.get("@stepkit/cli")?.dependencies?.["@stepkit/core"],
    "workspace:*",
    "@stepkit/cli must keep @stepkit/core as a workspace dependency",
  );
  assert.equal(
    manifestByName.get("@stepkit/cli")?.peerDependencies?.["@stepkit/core"],
    "^0.1.0",
    "@stepkit/cli must declare @stepkit/core 0.1 peer compatibility",
  );
  assert.equal(
    manifestByName.get("@stepkit/create-flows")?.dependencies?.["@stepkit/authoring"],
    "workspace:*",
    "@stepkit/create-flows must keep @stepkit/authoring as a workspace dependency",
  );
  assert.equal(
    manifestByName.get("@stepkit/create-flows")?.peerDependencies?.["@stepkit/authoring"],
    "^0.1.0",
    "@stepkit/create-flows must declare @stepkit/authoring 0.1 peer compatibility",
  );
  assert.ok(
    manifestByName.get("@stepkit/cli")?.files?.includes("stepkit-skill"),
    "@stepkit/cli must include stepkit-skill in published files",
  );
}

verifyPublicPackageMetadata();
console.log("Public package metadata verified.");
