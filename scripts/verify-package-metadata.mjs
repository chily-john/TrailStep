import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function assertFile(path) {
  assert.ok(existsSync(join(root, path)), `Expected ${path} to exist`);
}

const npmRepository = {
  type: "git",
  url: "git+ssh://git@github.com/chily-john/trailstep.git",
};

const workspacePackageDirectories = [
  "authoring",
  "cli",
  "core",
  "create-flows",
  "dashboard",
  "testkit",
];
const expectedWorkspacePackageNames = new Set(
  workspacePackageDirectories.map((directory) => `@trailstep/${directory}`),
);

function assertTrailStepManifest(packageMetadata, packageJsonPath) {
  assert.doesNotMatch(
    JSON.stringify(packageMetadata),
    /@stepkit\//u,
    `${packageJsonPath} must not contain legacy @stepkit/* package references`,
  );
  assert.doesNotMatch(
    JSON.stringify(packageMetadata),
    /\bstepkit\b|StepKit|STEPKIT/u,
    `${packageJsonPath} must use TrailStep naming in package metadata`,
  );
}

function assertInternalDependencyClosure(packageMetadata, packageJsonPath) {
  for (const dependencySection of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const dependencyName of Object.keys(packageMetadata[dependencySection] ?? {})) {
      assert.doesNotMatch(
        dependencyName,
        /^@stepkit\//u,
        `${packageJsonPath} ${dependencySection} must not depend on legacy ${dependencyName}`,
      );
      if (dependencyName.startsWith("@trailstep/")) {
        assert.ok(
          expectedWorkspacePackageNames.has(dependencyName),
          `${packageJsonPath} ${dependencySection} references unknown TrailStep workspace package ${dependencyName}`,
        );
      }
    }
  }
}

function assertRepositoryMetadata(packageMetadata, packageName) {
  assert.deepEqual(
    packageMetadata.repository,
    npmRepository,
    `${packageName} must declare npm repository metadata`,
  );
  assert.equal(
    packageMetadata.bugs?.url,
    "https://github.com/chily-john/trailstep/issues",
    `${packageName} must declare npm bugs metadata`,
  );
  assert.equal(
    packageMetadata.homepage,
    "https://github.com/chily-john/trailstep#readme",
    `${packageName} must declare npm homepage metadata`,
  );
}

function assertPublicPackageMetadata(packageMetadata, packageName) {
  assert.equal(packageMetadata.license, "Apache-2.0", `${packageName} must declare Apache-2.0`);
  assert.equal(
    packageMetadata.publishConfig?.access,
    "public",
    `${packageName} must publish as a public scoped package`,
  );
  assert.deepEqual(
    packageMetadata.files,
    ["dist", "README.md", "LICENSE"],
    `${packageName} must limit published files`,
  );
  assertRepositoryMetadata(packageMetadata, packageName);
}

export function verifyPackageMetadata() {
  const rootPackage = readJson("package.json");
  assertTrailStepManifest(rootPackage, "package.json");
  assertInternalDependencyClosure(rootPackage, "package.json");
  assert.equal(rootPackage.name, "trailstep", "root package name must be trailstep");
  assert.equal(rootPackage.private, true, "root package must be private");
  assert.match(rootPackage.packageManager ?? "", /^pnpm@/, "packageManager must use pnpm");
  assert.equal(rootPackage.engines?.node, ">=24.0.0", "root package must declare Node 24");

  for (const scriptName of [
    "build",
    "typecheck",
    "test",
    "lint",
    "changeset",
    "version",
    "publish:prepare",
  ]) {
    assert.equal(
      typeof rootPackage.scripts?.[scriptName],
      "string",
      `root script ${scriptName} is required`,
    );
  }
  assert.equal(rootPackage.scripts.changeset, "changeset");
  assert.equal(rootPackage.scripts.version, "changeset version");
  assert.match(rootPackage.scripts["publish:prepare"], /pnpm build/u);

  for (const [scriptName, scriptCommand] of Object.entries(rootPackage.scripts ?? {})) {
    assert.doesNotMatch(
      scriptCommand,
      /(^|\s)(changeset\s+publish|pnpm\s+publish|npm\s+publish)(\s|$)/u,
      `root script ${scriptName} must not publish packages automatically`,
    );
  }

  const changesetConfigPath = ".changeset/config.json";
  assertFile(changesetConfigPath);
  const changesetConfig = readJson(changesetConfigPath);
  assert.equal(
    changesetConfig.access,
    "public",
    "Changesets must default scoped packages to public access",
  );
  assert.equal(
    changesetConfig.baseBranch,
    "main",
    "Changesets must target the main release branch",
  );
  assert.deepEqual(
    changesetConfig.ignore ?? [],
    [],
    "Changesets must target the full pnpm workspace package set",
  );

  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /packages\/\*/u, "workspace must include packages/*");

  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /(^|\n)dist\/(\n|$)/u, "generated package dist output must be ignored");
  assert.match(gitignore, /(^|\n)\.turbo\/(\n|$)/u, "Turbo cache output must be ignored");

  const libraryPackages = [
    { directory: "core", name: "@trailstep/core" },
    { directory: "authoring", name: "@trailstep/authoring" },
    { directory: "testkit", name: "@trailstep/testkit" },
  ];

  const cliPackageJsonPath = "packages/cli/package.json";
  assertFile(cliPackageJsonPath);
  const cliPackageMetadata = readJson(cliPackageJsonPath);
  assertTrailStepManifest(cliPackageMetadata, cliPackageJsonPath);
  assertInternalDependencyClosure(cliPackageMetadata, cliPackageJsonPath);
  assert.equal(cliPackageMetadata.name, "@trailstep/cli");
  assertPublicPackageMetadata(cliPackageMetadata, "@trailstep/cli");
  assert.equal(cliPackageMetadata.bin?.trailstep, "./dist/index.js");
  assert.equal(cliPackageMetadata.bin?.stepkit, undefined);
  assert.match(
    cliPackageMetadata.dependencies?.["@clack/prompts"] ?? "",
    /^\^/u,
    "@trailstep/cli must depend on @clack/prompts for interactive commands",
  );
  assert.equal(
    cliPackageMetadata.dependencies?.["@trailstep/core"],
    "workspace:*",
    "@trailstep/cli must retain a workspace dependency on @trailstep/core for builds",
  );
  assert.equal(
    cliPackageMetadata.peerDependencies?.["@trailstep/core"],
    "^0.0.0",
    "@trailstep/cli must declare @trailstep/core peer compatibility",
  );

  const dashboardPackageJsonPath = "packages/dashboard/package.json";
  assertFile(dashboardPackageJsonPath);
  const dashboardPackageMetadata = readJson(dashboardPackageJsonPath);
  assertTrailStepManifest(dashboardPackageMetadata, dashboardPackageJsonPath);
  assertInternalDependencyClosure(dashboardPackageMetadata, dashboardPackageJsonPath);
  assert.equal(dashboardPackageMetadata.name, "@trailstep/dashboard");
  assertPublicPackageMetadata(dashboardPackageMetadata, "@trailstep/dashboard");
  assert.equal(dashboardPackageMetadata.type, "module");
  assert.match(dashboardPackageMetadata.scripts?.build ?? "", /vite build/u);
  assert.match(dashboardPackageMetadata.scripts?.typecheck ?? "", /svelte-check/u);
  assert.match(dashboardPackageMetadata.scripts?.test ?? "", /vitest run/u);
  assert.match(
    dashboardPackageMetadata.devDependencies?.["@sveltejs/vite-plugin-svelte"] ?? "",
    /\^/u,
  );
  assert.match(dashboardPackageMetadata.devDependencies?.svelte ?? "", /\^/u);
  assert.match(dashboardPackageMetadata.devDependencies?.vite ?? "", /\^/u);

  const createFlowsPackageJsonPath = "packages/create-flows/package.json";
  assertFile(createFlowsPackageJsonPath);
  const createFlowsPackageMetadata = readJson(createFlowsPackageJsonPath);
  assertTrailStepManifest(createFlowsPackageMetadata, createFlowsPackageJsonPath);
  assertInternalDependencyClosure(createFlowsPackageMetadata, createFlowsPackageJsonPath);
  assert.equal(createFlowsPackageMetadata.name, "@trailstep/create-flows");
  assert.deepEqual(createFlowsPackageMetadata.keywords, ["trailstep-workflow"]);
  assert.equal(createFlowsPackageMetadata.dependencies?.["@trailstep/authoring"], "workspace:*");
  assert.equal(createFlowsPackageMetadata.devDependencies?.["@trailstep/core"], "workspace:*");

  for (const libraryPackage of libraryPackages) {
    const packageJsonPath = `packages/${libraryPackage.directory}/package.json`;
    assertFile(packageJsonPath);

    const packageMetadata = readJson(packageJsonPath);
    assertTrailStepManifest(packageMetadata, packageJsonPath);
    assertInternalDependencyClosure(packageMetadata, packageJsonPath);
    assert.equal(packageMetadata.name, libraryPackage.name);
    assertPublicPackageMetadata(packageMetadata, libraryPackage.name);
    assert.equal(packageMetadata.type, "module", `${libraryPackage.name} must be ESM-only`);
    assert.equal(packageMetadata.main, "./dist/index.js");
    assert.equal(packageMetadata.types, "./dist/index.d.ts");
    assert.equal(packageMetadata.exports?.["."].import, "./dist/index.js");
    assert.equal(packageMetadata.exports?.["."].types, "./dist/index.d.ts");

    if (libraryPackage.name === "@trailstep/authoring") {
      assert.equal(
        packageMetadata.dependencies?.["@trailstep/core"],
        "workspace:*",
        "@trailstep/authoring must retain a workspace dependency on @trailstep/core for builds",
      );
      assert.equal(
        packageMetadata.peerDependencies?.["@trailstep/core"],
        "^0.0.0",
        "@trailstep/authoring must declare @trailstep/core peer compatibility",
      );
    }

    for (const scriptName of ["build", "typecheck", "test", "lint"]) {
      assert.equal(
        typeof packageMetadata.scripts?.[scriptName],
        "string",
        `${libraryPackage.directory} script ${scriptName} is required`,
      );
    }

    assert.match(
      packageMetadata.scripts.build,
      /--clean/u,
      `${libraryPackage.name} build must clean generated dist before rebuilding`,
    );
  }
}

verifyPackageMetadata();
console.log("Package metadata verified.");
