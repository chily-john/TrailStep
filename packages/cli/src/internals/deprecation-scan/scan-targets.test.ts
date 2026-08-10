import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveBundleWorkflowScanTargets, resolveDeprecationScanTargets } from "./scan-targets.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tmpDir(task: { readonly id: string }, variant: string): string {
  return join("node_modules", ".tmp-trailstep-scan-targets-tests", `${task.id}-${variant}`);
}

describe("resolveDeprecationScanTargets", () => {
  it("includes registered direct-file workflows for doctor scans", async ({ task }) => {
    const cwd = tmpDir(task, "direct-doctor");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "local.mjs"), "export const local = {};\n", "utf8");
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { local: "./workflows/local.mjs" } },
    });

    const targets = await resolveDeprecationScanTargets({ cwd });

    expect(targets).toEqual([{ sourceFile: resolve(cwd, "workflows", "local.mjs") }]);
  });

  it("skips direct-file workflows for workflow package update scans", async ({ task }) => {
    const cwd = tmpDir(task, "direct-workflow-update");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "local.mjs"), "export const local = {};\n", "utf8");
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { local: "./workflows/local.mjs" } },
    });

    const targets = await resolveDeprecationScanTargets({
      cwd,
      scanMode: "workflow-package-update",
    });

    expect(targets).toEqual([]);
  });

  it("resolves user-scope direct-file workflows relative to the user registry base", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "user-direct-cwd");
    const homeDir = tmpDir(task, "user-direct-home");
    await mkdir(join(homeDir, "workflows"), { recursive: true });
    await writeFile(
      join(homeDir, "workflows", "global.mjs"),
      "export const global = {};\n",
      "utf8",
    );
    await writeJson(join(homeDir, ".trailstep", "config.json"), {
      workflows: { user: { global: "./workflows/global.mjs" } },
    });

    const targets = await resolveDeprecationScanTargets({ cwd, homeDir });

    expect(targets).toEqual([{ sourceFile: resolve(homeDir, "workflows", "global.mjs") }]);
  });

  it("resolves registered package entrypoint using exports import field", async ({ task }) => {
    const cwd = tmpDir(task, "package-exports");
    const packageDir = join(cwd, "node_modules", "@acme", "plain-pkg");

    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { plain: "@acme/plain-pkg" } },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/plain-pkg",
      version: "1.0.0",
      exports: { ".": { import: "./dist/import-entry.mjs" } },
      module: "./dist/module.mjs",
      main: "./dist/main.cjs",
    });

    const targets = await resolveDeprecationScanTargets({ cwd });

    expect(targets).toEqual([{ sourceFile: resolve(packageDir, "dist/import-entry.mjs") }]);
  });

  it("resolves registered bundle workflow source through shared bundle manifest parsing", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "bundle-source");
    const bundleDir = join(cwd, "node_modules", "@acme", "bundle");

    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { release: "@acme/bundle#release" } },
    });
    await writeJson(join(bundleDir, "package.json"), {
      name: "@acme/bundle",
      version: "1.0.0",
      main: "./index.mjs",
      trailstep: {
        workflows: {
          release: "./dist/release.mjs#releaseWorkflow",
          cleanup: "./dist/cleanup.mjs#cleanupWorkflow",
        },
      },
    });

    const targets = await resolveDeprecationScanTargets({ cwd });

    expect(targets).toEqual([{ sourceFile: resolve(bundleDir, "dist/release.mjs") }]);
  });

  it("resolves registered local bundle package workflow source through its manifest", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "local-bundle-source");
    const bundleDir = join(cwd, "local-workflow-package");

    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { cleanup: "./local-workflow-package#cleanup" } },
    });
    await writeJson(join(bundleDir, "package.json"), {
      name: "local-workflow-package",
      version: "1.0.0",
      trailstep: {
        workflows: {
          cleanup: "./src/cleanup.mjs#cleanupWorkflow",
        },
      },
    });

    const targets = await resolveDeprecationScanTargets({ cwd });

    expect(targets).toEqual([{ sourceFile: resolve(bundleDir, "src/cleanup.mjs") }]);
  });

  it("uses discoverWorkflows for discovered package scan targets", async ({ task }) => {
    const cwd = tmpDir(task, "discovered");
    const discoveredDir = join(cwd, "node_modules", "@acme", "discovered");
    const unlistedDir = join(cwd, "node_modules", "@acme", "unlisted");

    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: { "@acme/discovered": "1.0.0" },
    });
    await writeJson(join(discoveredDir, "package.json"), {
      name: "@acme/discovered",
      version: "1.0.0",
      type: "module",
      exports: { ".": { import: "./dist/workflows.mjs" } },
      keywords: ["trailstep-workflow"],
    });
    await mkdir(join(discoveredDir, "dist"), { recursive: true });
    await writeFile(
      join(discoveredDir, "dist", "workflows.mjs"),
      [
        "const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };",
        "export const review = { id: 'review', inputShape: {}, output: schema, start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );
    await writeJson(join(unlistedDir, "package.json"), {
      name: "@acme/unlisted",
      version: "1.0.0",
      keywords: ["trailstep-workflow"],
      main: "./wrongly-scanned.mjs",
    });

    const targets = await resolveDeprecationScanTargets({ cwd, includeDiscovered: true });

    expect(targets).toEqual([{ sourceFile: resolve(discoveredDir, "dist/workflows.mjs") }]);
  });

  it("resolves every workflow source from a bundle package manifest", async ({ task }) => {
    const cwd = tmpDir(task, "bundle-scan-targets");
    const bundleDir = join(cwd, "node_modules", "@acme", "bundle");

    await writeJson(join(bundleDir, "package.json"), {
      name: "@acme/bundle",
      version: "1.0.0",
      trailstep: {
        workflows: {
          release: "./dist/release.mjs#releaseWorkflow",
          cleanup: "./dist/cleanup.mjs#cleanupWorkflow",
        },
      },
    });

    const targets = await resolveBundleWorkflowScanTargets("@acme/bundle", cwd);

    expect(targets).toEqual([
      { sourceFile: resolve(bundleDir, "dist/release.mjs") },
      { sourceFile: resolve(bundleDir, "dist/cleanup.mjs") },
    ]);
  });

  it("skips malformed bundle manifest targets instead of scanning a drifted path", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "invalid-bundle-target");
    const bundleDir = join(cwd, "node_modules", "@acme", "bundle");

    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { release: "@acme/bundle#release" } },
    });
    await writeJson(join(bundleDir, "package.json"), {
      name: "@acme/bundle",
      version: "1.0.0",
      main: "./index.mjs",
      trailstep: { workflows: { release: "./dist/release.mjs" } },
    });

    await expect(resolveDeprecationScanTargets({ cwd })).resolves.toEqual([]);
  });
});
