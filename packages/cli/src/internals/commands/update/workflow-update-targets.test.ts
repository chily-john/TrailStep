import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PackageCommandRunner } from "../../command.types.js";
import {
  resolveWorkflowPackageUpdateTargets,
  type WorkflowPackageUpdateTarget,
} from "./workflow-update-targets.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createPackageCommandRunner(versionsByPackageName: Record<string, readonly string[]>): {
  runner: PackageCommandRunner;
  viewedPackages: string[];
} {
  const viewedPackages: string[] = [];
  return {
    viewedPackages,
    runner: async ({ args }) => {
      const packageName = args[1]?.replace(/@\*$/u, "");
      const versions = packageName ? versionsByPackageName[packageName] : undefined;
      if (!packageName || !versions) {
        return { exitCode: 1, stderr: `missing metadata for ${packageName ?? "unknown"}` };
      }
      viewedPackages.push(packageName);
      return {
        exitCode: 0,
        stdout: JSON.stringify(versions.map((version) => ({ version }))),
      };
    },
  };
}

function targetSummary(targets: readonly WorkflowPackageUpdateTarget[]) {
  return targets.map((target) => ({
    packageName: target.packageName,
    registeredRefs: target.registeredRefs,
    currentRange: target.currentRange,
    dependencySection: target.dependencySection,
    installedVersion: target.installedVersion,
    targetVersion: target.targetVersion,
  }));
}

describe("resolveWorkflowPackageUpdateTargets", () => {
  it("resolves latest stable version and dependency section for registered workflow packages", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, "package.json"), {
      devDependencies: { "@acme/review-workflow": "^1.2.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/review-workflow" } },
    });
    await writeJson(join(cwd, "node_modules", "@acme", "review-workflow", "package.json"), {
      name: "@acme/review-workflow",
      version: "1.2.3",
    });
    const { runner } = createPackageCommandRunner({
      "@acme/review-workflow": ["1.2.3", "2.0.0-beta.1", "1.4.0"],
    });

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      scope: { kind: "workflows" },
      packageCommandRunner: runner,
    });

    expect(targetSummary(plan.targets)).toEqual([
      {
        packageName: "@acme/review-workflow",
        registeredRefs: ["project/review"],
        currentRange: "^1.2.0",
        dependencySection: "devDependencies",
        installedVersion: "1.2.3",
        targetVersion: "1.4.0",
      },
    ]);
    expect(plan.skips).toEqual([]);
  });

  it("dedupes multiple registrations for the same package", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@acme/workflows": "^1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: {
        project: {
          review: "@acme/workflows#review",
          release: "@acme/workflows#release",
        },
      },
    });
    await writeJson(join(cwd, "node_modules", "@acme", "workflows", "package.json"), {
      name: "@acme/workflows",
      version: "1.0.1",
    });
    const { runner, viewedPackages } = createPackageCommandRunner({
      "@acme/workflows": ["1.0.1", "1.1.0"],
    });

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      scope: { kind: "workflows" },
      packageCommandRunner: runner,
    });

    expect(targetSummary(plan.targets)).toEqual([
      {
        packageName: "@acme/workflows",
        registeredRefs: ["project/review", "project/release"],
        currentRange: "^1.0.0",
        dependencySection: "dependencies",
        installedVersion: "1.0.1",
        targetVersion: "1.1.0",
      },
    ]);
    expect(viewedPackages).toEqual(["@acme/workflows"]);
  });

  it("reports direct-file registrations as skips without npm view calls", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    const { runner, viewedPackages } = createPackageCommandRunner({});

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      scope: { kind: "workflows" },
      packageCommandRunner: runner,
    });

    expect(plan.targets).toEqual([]);
    expect(plan.skips).toEqual([
      {
        registeredRef: "project/review",
        reason: "local-file-source",
        message: "Skipped project/review: local file source, no version to update.",
      },
    ]);
    expect(viewedPackages).toEqual([]);
  });

  it("errors on ambiguous bare workflow names", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: {
        project: { review: "@acme/project-review" },
        other: { review: "@acme/other-review" },
      },
    });
    const { runner } = createPackageCommandRunner({});

    await expect(
      resolveWorkflowPackageUpdateTargets({
        cwd,
        scope: { kind: "workflow", name: "review" },
        packageCommandRunner: runner,
      }),
    ).rejects.toThrow('Ambiguous workflow name "review" matches project/review, other/review.');
  });

  it("falls back to raw package name when no registration matches", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, "package.json"), {
      peerDependencies: { "@acme/workflows": "~2.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@acme", "workflows", "package.json"), {
      name: "@acme/workflows",
      version: "2.0.1",
    });
    const { runner } = createPackageCommandRunner({ "@acme/workflows": ["2.0.1", "2.1.0"] });

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      scope: { kind: "workflow", name: "@acme/workflows" },
      packageCommandRunner: runner,
    });

    expect(targetSummary(plan.targets)).toEqual([
      {
        packageName: "@acme/workflows",
        registeredRefs: [],
        currentRange: "~2.0.0",
        dependencySection: "peerDependencies",
        installedVersion: "2.0.1",
        targetVersion: "2.1.0",
      },
    ]);
  });

  it("errors clearly when target package is not in root dependencies", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, "package.json"), { dependencies: {} });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/review-workflow" } },
    });
    await writeJson(join(cwd, "node_modules", "@acme", "review-workflow", "package.json"), {
      name: "@acme/review-workflow",
      version: "1.2.3",
    });
    const { runner } = createPackageCommandRunner({ "@acme/review-workflow": ["1.2.3"] });

    await expect(
      resolveWorkflowPackageUpdateTargets({
        cwd,
        scope: { kind: "workflows" },
        packageCommandRunner: runner,
      }),
    ).rejects.toThrow(
      "Cannot update @acme/review-workflow: package is not listed in root dependencies, devDependencies, or peerDependencies.",
    );
  });
});
