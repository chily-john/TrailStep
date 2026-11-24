import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LintEntrypointViolation,
  lintEntrypointViolations,
  type PackageManifestShape,
  type WorkspacePackageShape,
} from "./redundant-lint-entrypoint.js";
import { findRepoRoot } from "./root.js";

const WORKSPACE_ROOTS = ["packages", "factory"];

const repoRoot = findRepoRoot();

function readManifest(relativePath: string): PackageManifestShape {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as PackageManifestShape;
}

/** Every directory under `packages/` or `factory/` that holds a package manifest. */
function workspaceManifests(): WorkspacePackageShape[] {
  const packages: WorkspacePackageShape[] = [];

  for (const workspaceRoot of WORKSPACE_ROOTS) {
    for (const entry of readdirSync(join(repoRoot, workspaceRoot), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const directory = `${workspaceRoot}/${entry.name}`;
      try {
        readFileSync(join(repoRoot, directory, "package.json"));
      } catch {
        continue;
      }

      packages.push({ directory, manifest: readManifest(`${directory}/package.json`) });
    }
  }

  return packages.sort((left, right) => left.directory.localeCompare(right.directory));
}

function realViolations(): LintEntrypointViolation[] {
  const turbo = JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf8")) as {
    tasks?: Record<string, unknown>;
  };

  return lintEntrypointViolations({
    packages: workspaceManifests(),
    turboTasks: turbo.tasks ?? {},
    rootManifest: readManifest("package.json"),
  });
}

function messagesFor(key: LintEntrypointViolation["key"]): string[] {
  return realViolations()
    .filter((violation) => violation.key === key)
    .map((violation) => violation.message);
}

function fixtureViolations({
  packages = [],
  turboTasks = {},
  rootLint = "biome check .",
}: {
  packages?: WorkspacePackageShape[];
  turboTasks?: Record<string, unknown>;
  rootLint?: string | null;
}): LintEntrypointViolation[] {
  return lintEntrypointViolations({
    packages,
    turboTasks,
    rootManifest: rootLint === null ? {} : { scripts: { lint: rootLint } },
  });
}

describe("redundant lint entry points", () => {
  it("discovers the workspace packages it guards", () => {
    expect(workspaceManifests().length).toBeGreaterThan(0);
  });

  it("declares no package-level lint script", () => {
    expect(messagesFor("package-script").join("\n")).toBe("");
  });

  it("has no turbo lint task", () => {
    expect(messagesFor("turbo-task").join("\n")).toBe("");
  });

  it("runs biome once from the root", () => {
    expect(messagesFor("root-script").join("\n")).toBe("");
  });

  it("runs biome over the whole tree from the root", () => {
    expect(messagesFor("root-target").join("\n")).toBe("");
  });

  it("names the package and the fix for a package-level lint script", () => {
    const violations = fixtureViolations({
      packages: [
        {
          directory: "packages/fixture",
          manifest: { name: "@trailstep/fixture", scripts: { lint: "biome check src" } },
        },
      ],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("packages/fixture/package.json");
    expect(violations[0]?.message).toContain("@trailstep/fixture");
    expect(violations[0]?.message).toContain("biome check .");
  });

  it("names turbo.json for a lint task", () => {
    const violations = fixtureViolations({ turboTasks: { lint: { outputs: [] } } });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.key).toBe("turbo-task");
    expect(violations[0]?.message).toContain("turbo.json");
  });

  it("rejects a root command that is missing, chained, or not biome", () => {
    expect(fixtureViolations({ rootLint: null })).toHaveLength(1);
    expect(fixtureViolations({ rootLint: "turbo run lint" }).map(({ key }) => key)).toEqual([
      "root-script",
      "root-script",
    ]);
    expect(fixtureViolations({ rootLint: "biome check . && turbo run lint" })).toHaveLength(1);
  });

  it.each([
    ["a subdirectory", "biome check src"],
    ["a relative subdirectory", "biome check ./src"],
    ["no target", "biome check"],
  ])("rejects %s as the root lint target", (_label, rootLint) => {
    const violations = fixtureViolations({ rootLint });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.key).toBe("root-target");
    expect(violations[0]?.message).toContain("package.json: scripts.lint");
    expect(violations[0]?.message).toContain(JSON.stringify(rootLint));
    expect(violations[0]?.message).toContain(
      "a narrower target silently leaves files outside it unchecked",
    );
  });

  it("does not pin the root command beyond a single biome invocation", () => {
    expect(fixtureViolations({ rootLint: "biome check . --error-on-warnings" })).toEqual([]);
    expect(fixtureViolations({ rootLint: "biome check ./" })).toEqual([]);
  });
});
