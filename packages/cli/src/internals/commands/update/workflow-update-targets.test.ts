import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveWorkflowPackageUpdateTargets,
  type WorkflowPackageUpdateTarget,
} from "./workflow-update-targets.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function targetSummary(targets: readonly WorkflowPackageUpdateTarget[]) {
  return targets.map((target) => ({
    packageName: target.packageName,
    registeredRefs: target.registeredRefs,
  }));
}

describe("resolveWorkflowPackageUpdateTargets", () => {
  it("skips registered direct-file entries for update", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "./workflows/review.mjs" } },
    });

    const plan = await resolveWorkflowPackageUpdateTargets({ cwd, scope: { kind: "workflows" } });

    expect(plan.targets).toEqual([]);
    expect(plan.skips).toEqual([
      {
        registeredRef: "project/review",
        reason: "local-file-source",
        message: "Skipped project/review: local file source, no version to update.",
      },
    ]);
  });

  it("resolves a registered plain package to one package update target", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "@acme/review-workflow" } },
    });

    const plan = await resolveWorkflowPackageUpdateTargets({ cwd, scope: { kind: "workflows" } });

    expect(targetSummary(plan.targets)).toEqual([
      { packageName: "@acme/review-workflow", registeredRefs: ["project/review"] },
    ]);
    expect(plan.targets[0]?.sourceFiles).toEqual([join(cwd, ".stepkit", "config.json")]);
    expect(plan.skips).toEqual([]);
  });

  it("dedupes registered bundle package targets across multiple workflow names", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: {
        project: {
          review: "@acme/workflows#review",
          release: "@acme/workflows#release",
        },
      },
    });

    const plan = await resolveWorkflowPackageUpdateTargets({ cwd, scope: { kind: "workflows" } });

    expect(targetSummary(plan.targets)).toEqual([
      { packageName: "@acme/workflows", registeredRefs: ["project/review", "project/release"] },
    ]);
  });

  it("resolves --workflow to only that registered target", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: {
        project: {
          review: "@acme/review-workflow",
          release: "@acme/release-workflow",
        },
      },
    });

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      scope: { kind: "workflow", name: "project/review" },
    });

    expect(targetSummary(plan.targets)).toEqual([
      { packageName: "@acme/review-workflow", registeredRefs: ["project/review"] },
    ]);
  });

  it("falls back from --workflow raw package names to a package target", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-workflow-update-target-tests", task.id);
    await mkdir(cwd, { recursive: true });

    const plan = await resolveWorkflowPackageUpdateTargets({
      cwd,
      scope: { kind: "workflow", name: "@acme/workflows" },
    });

    expect(targetSummary(plan.targets)).toEqual([
      { packageName: "@acme/workflows", registeredRefs: [] },
    ]);
    expect(plan.targets[0]?.sourceFiles).toEqual([join(cwd, "package.json")]);
  });

  it("does not include discovered keyword packages in --workflows unless registered", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-workflow-update-target-tests", task.id);
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@acme/discovered-workflow": "^1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@acme", "discovered-workflow", "package.json"), {
      name: "@acme/discovered-workflow",
      version: "1.0.0",
      keywords: ["stepkit-workflow"],
    });

    const plan = await resolveWorkflowPackageUpdateTargets({ cwd, scope: { kind: "workflows" } });

    expect(plan.targets).toEqual([]);
    expect(plan.skips).toEqual([]);
  });
});
