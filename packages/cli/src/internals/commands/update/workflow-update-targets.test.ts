import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  viewedCwds: string[];
} {
  const viewedPackages: string[] = [];
  const viewedCwds: string[] = [];
  return {
    viewedPackages,
    viewedCwds,
    runner: async ({ args, cwd }) => {
      const packageName = args[1]?.replace(/@\*$/u, "");
      const versions = packageName ? versionsByPackageName[packageName] : undefined;
      if (!packageName || !versions) {
        return { exitCode: 1, stderr: `missing metadata for ${packageName ?? "unknown"}` };
      }
      viewedPackages.push(packageName);
      viewedCwds.push(cwd);
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

function workflowPackageMetadata({
  installScope,
  packageName = "@acme/workflows",
  requestedRange = "^1.0.0",
  targetRef,
  workflowName,
  exportName,
}: {
  readonly installScope: "project" | "global";
  readonly packageName?: string;
  readonly requestedRange?: string;
  readonly targetRef?: string;
  readonly workflowName: string;
  readonly exportName: string;
}): Record<string, unknown> {
  return {
    kind: "package",
    sourceType: "npm",
    packageName,
    requestedSpec: `${packageName}@${requestedRange}`,
    requestedRange,
    installScope,
    targetRef: targetRef ?? `${packageName}#${workflowName}`,
    workflowName,
    exportName,
  };
}

describe("resolveWorkflowPackageUpdateTargets", () => {
  it("resolves project and global workflow package targets from metadata install roots", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    const homeDir = join(
      "node_modules",
      ".tmp-trailstep-workflow-update-target-tests",
      `${task.id}-home`,
    );
    const globalInstallRoot = join(homeDir, ".trailstep", "packages");

    await writeJson(join(cwd, "package.json"), {
      devDependencies: { "@acme/workflows": "^1.0.0" },
    });
    await writeJson(join(globalInstallRoot, "package.json"), {
      dependencies: { "@acme/workflows": "^2.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: {
        project: {
          review: "@acme/workflows#review",
          release: "@acme/workflows#release",
          local: "./workflows/local.mjs",
        },
      },
      workflowMetadata: {
        project: {
          review: workflowPackageMetadata({
            installScope: "project",
            workflowName: "review",
            exportName: "reviewWorkflow",
          }),
          release: workflowPackageMetadata({
            installScope: "project",
            workflowName: "release",
            exportName: "releaseWorkflow",
          }),
        },
      },
    });
    await writeJson(join(homeDir, ".trailstep", "config.json"), {
      workflows: { global: { review: "@acme/workflows#review" } },
      workflowMetadata: {
        global: {
          review: workflowPackageMetadata({
            installScope: "global",
            requestedRange: "^2.0.0",
            workflowName: "review",
            exportName: "globalReviewWorkflow",
          }),
        },
      },
    });
    await writeJson(join(cwd, "node_modules", "@acme", "workflows", "package.json"), {
      name: "@acme/workflows",
      version: "1.0.1",
      trailstep: {
        workflows: {
          review: "./dist/review.mjs#reviewWorkflow",
          release: "./dist/release.mjs#releaseWorkflow",
        },
      },
    });
    await writeJson(join(globalInstallRoot, "node_modules", "@acme", "workflows", "package.json"), {
      name: "@acme/workflows",
      version: "2.0.1",
      trailstep: {
        workflows: {
          review: "./dist/global-review.mjs#globalReviewWorkflow",
        },
      },
    });
    const { runner, viewedPackages, viewedCwds } = createPackageCommandRunner({
      "@acme/workflows": ["1.0.1", "2.0.1", "2.1.0"],
    });

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      homeDir,
      scope: { kind: "workflows" },
      packageCommandRunner: runner,
    });

    expect(plan.targets).toEqual([
      {
        packageName: "@acme/workflows",
        sourceType: "npm",
        installScope: "project",
        installRoot: cwd,
        registeredRefs: ["project/review", "project/release"],
        currentRange: "^1.0.0",
        dependencySection: "devDependencies",
        installedVersion: "1.0.1",
        targetVersion: "2.1.0",
        sourceFiles: [
          resolve(cwd, "node_modules", "@acme", "workflows", "dist", "review.mjs"),
          resolve(cwd, "node_modules", "@acme", "workflows", "dist", "release.mjs"),
        ],
      },
      {
        packageName: "@acme/workflows",
        sourceType: "npm",
        installScope: "global",
        installRoot: globalInstallRoot,
        registeredRefs: ["global/review"],
        currentRange: "^2.0.0",
        dependencySection: "dependencies",
        installedVersion: "2.0.1",
        targetVersion: "2.1.0",
        sourceFiles: [
          resolve(
            globalInstallRoot,
            "node_modules",
            "@acme",
            "workflows",
            "dist",
            "global-review.mjs",
          ),
        ],
      },
    ]);
    expect(plan.skips).toEqual([
      {
        registeredRef: "project/local",
        reason: "local-file-source",
        message: "Skipped project/local: local file source, no version to update.",
      },
    ]);
    expect(viewedPackages).toEqual(["@acme/workflows", "@acme/workflows"]);
    expect(viewedCwds).toHaveLength(2);
    expect(viewedCwds).toEqual(expect.arrayContaining([cwd, globalInstallRoot]));
  });

  it("skips package registrations that are missing package metadata without npm view calls", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@acme/workflows": "^1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/workflows#review" } },
    });
    await writeJson(join(cwd, "node_modules", "@acme", "workflows", "package.json"), {
      name: "@acme/workflows",
      version: "1.0.0",
    });
    const { runner, viewedPackages } = createPackageCommandRunner({
      "@acme/workflows": ["1.0.0", "1.1.0"],
    });

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      scope: { kind: "workflows" },
      packageCommandRunner: runner,
    });

    expect(plan.targets).toEqual([]);
    expect(plan.skips).toEqual([
      {
        registeredRef: "project/review",
        reason: "missing-package-metadata",
        message:
          "Skipped project/review: workflow package metadata is missing; re-add the workflow before updating this package.",
      },
    ]);
    expect(viewedPackages).toEqual([]);
  });

  it("resolves latest stable version and dependency section for registered workflow packages", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, "package.json"), {
      devDependencies: { "@acme/review-workflow": "^1.2.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/review-workflow" } },
      workflowMetadata: {
        project: {
          review: workflowPackageMetadata({
            installScope: "project",
            packageName: "@acme/review-workflow",
            targetRef: "@acme/review-workflow",
            workflowName: "review",
            exportName: "review",
          }),
        },
      },
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
      workflowMetadata: {
        project: {
          review: workflowPackageMetadata({
            installScope: "project",
            workflowName: "review",
            exportName: "reviewWorkflow",
          }),
          release: workflowPackageMetadata({
            installScope: "project",
            workflowName: "release",
            exportName: "releaseWorkflow",
          }),
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

  it("skips stale package metadata without npm view calls", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/workflows#review" } },
      workflowMetadata: {
        project: {
          review: workflowPackageMetadata({
            installScope: "project",
            targetRef: "@acme/workflows#old-review",
            workflowName: "old-review",
            exportName: "oldReviewWorkflow",
          }),
        },
      },
    });
    const { runner, viewedPackages } = createPackageCommandRunner({
      "@acme/workflows": ["1.0.0", "1.1.0"],
    });

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      scope: { kind: "workflows" },
      packageCommandRunner: runner,
    });

    expect(plan.targets).toEqual([]);
    expect(plan.skips).toEqual([
      {
        registeredRef: "project/review",
        reason: "stale-package-metadata",
        message:
          "Skipped project/review: workflow package metadata is stale; re-add the workflow before updating this package.",
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

  it("returns no workflow package targets when no registration matches", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, "package.json"), {
      peerDependencies: { "@acme/workflows": "~2.0.0" },
    });
    const { runner, viewedPackages } = createPackageCommandRunner({
      "@acme/workflows": ["2.0.1", "2.1.0"],
    });

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      scope: { kind: "workflow", name: "@acme/workflows" },
      packageCommandRunner: runner,
    });

    expect(plan.targets).toEqual([]);
    expect(plan.skips).toEqual([]);
    expect(viewedPackages).toEqual([]);
  });

  it("errors clearly when target package is not in root dependencies", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, "package.json"), { dependencies: {} });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/review-workflow" } },
      workflowMetadata: {
        project: {
          review: workflowPackageMetadata({
            installScope: "project",
            packageName: "@acme/review-workflow",
            targetRef: "@acme/review-workflow",
            workflowName: "review",
            exportName: "review",
          }),
        },
      },
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
