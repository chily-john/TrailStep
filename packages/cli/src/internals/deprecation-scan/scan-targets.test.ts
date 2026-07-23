import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDeprecationScanTargets } from "./scan-targets.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tmpDir(task: { readonly id: string }, variant: string): string {
  return join("node_modules", ".tmp-stepkit-scan-targets-tests", `${task.id}-${variant}`);
}

describe("resolveDeprecationScanTargets", () => {
  it("resolves bundle and plain-package targets while excluding a direct-file registered entry", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "mixed");
    const bundleDir = join(cwd, "node_modules", "@acme", "bundle");
    const plainDir = join(cwd, "node_modules", "@acme", "plain-pkg");

    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: {
        project: {
          local: "./workflows/local.mjs",
          release: "@acme/bundle#release",
          cleanup: "@acme/bundle#cleanup",
          plain: "@acme/plain-pkg",
        },
      },
    });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "local.mjs"), "export const local = {};\n", "utf8");
    await writeJson(join(bundleDir, "package.json"), {
      name: "@acme/bundle",
      version: "1.0.0",
      main: "./index.mjs",
      stepkit: {
        workflows: {
          release: "./dist/release.mjs",
          cleanup: "./dist/cleanup.mjs",
        },
      },
    });
    await writeJson(join(plainDir, "package.json"), {
      name: "@acme/plain-pkg",
      version: "1.0.0",
      main: "./index.mjs",
    });

    const targets = await resolveDeprecationScanTargets({ cwd });
    const sourceFiles = targets.map((target) => target.sourceFile);

    expect(sourceFiles).toHaveLength(3);
    expect(sourceFiles).toEqual(
      expect.arrayContaining([
        resolve(bundleDir, "dist/release.mjs"),
        resolve(bundleDir, "dist/cleanup.mjs"),
        resolve(plainDir, "index.mjs"),
      ]),
    );
    expect(sourceFiles.some((sourceFile) => sourceFile.includes("local.mjs"))).toBe(false);
  });

  it("returns no targets when only a direct-file entry is registered", async ({ task }) => {
    const cwd = tmpDir(task, "direct-only");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "local.mjs"), "export const local = {};\n", "utf8");
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { local: "./workflows/local.mjs" } },
    });

    const targets = await resolveDeprecationScanTargets({ cwd });

    expect(targets).toEqual([]);
  });
});
