import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverWorkflows, resolvePackageEntryFilePath } from "./discovery.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createWorkflowPackage(cwd: string): Promise<void> {
  const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
  await mkdir(packageDir, { recursive: true });
  await writeJson(join(packageDir, "package.json"), {
    name: "@acme/trailstep-workflows",
    version: "1.0.0",
    type: "module",
    main: "./index.mjs",
    keywords: ["trailstep-workflow"],
  });
  await writeFile(
    join(packageDir, "index.mjs"),
    [
      "const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };",
      "export const reviewFeature = { id: 'reviewFeature', inputShape: { task: 'string' }, output: schema, start: (input) => ({ kind: 'done', output: input }) };",
      "export const invalidExport = { id: 'invalidExport' };",
      "export default { id: 'defaultWorkflow', inputShape: { task: 'string' }, start: (input) => ({ kind: 'done', output: input }) };",
    ].join("\n"),
    "utf8",
  );
}

describe("discoverWorkflows", () => {
  it("resolves package entry files with exports/module/main/default precedence", () => {
    const packageDir = resolve("node_modules", ".tmp-trailstep-entry-tests", "package");

    expect(
      resolvePackageEntryFilePath(
        {
          exports: { ".": { import: "./dist/index.mjs" } },
          module: "./module.mjs",
          main: "./main.cjs",
        },
        packageDir,
      ),
    ).toBe(join(packageDir, "dist", "index.mjs"));
    expect(
      resolvePackageEntryFilePath({ exports: "./exports.mjs", module: "./module.mjs" }, packageDir),
    ).toBe(join(packageDir, "exports.mjs"));
    expect(
      resolvePackageEntryFilePath({ module: "./module.mjs", main: "./main.cjs" }, packageDir),
    ).toBe(join(packageDir, "module.mjs"));
    expect(resolvePackageEntryFilePath({ main: "./main.cjs" }, packageDir)).toBe(
      join(packageDir, "main.cjs"),
    );
    expect(resolvePackageEntryFilePath({}, packageDir)).toBe(join(packageDir, "index.js"));
  });

  it("discovers named continuation workflow exports from trailstep-workflow packages", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-discovery-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      type: "module",
      dependencies: {
        "@acme/trailstep-workflows": "1.0.0",
      },
    });
    await createWorkflowPackage(cwd);

    await expect(discoverWorkflows({ cwd })).resolves.toEqual([
      {
        id: "@acme/trailstep-workflows:reviewFeature",
        packageName: "@acme/trailstep-workflows",
        packageDir: resolve(cwd, "node_modules", "@acme", "trailstep-workflows"),
        exportName: "reviewFeature",
        workflow: expect.objectContaining({ id: "reviewFeature" }),
      },
    ]);
  });

  it("returns packageDir for discovered workflow packages", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-discovery-tests", `${task.id}-package-dir`);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(cwd, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: {
        "@acme/trailstep-workflows": "1.0.0",
      },
    });
    await createWorkflowPackage(cwd);

    const workflows = await discoverWorkflows({ cwd });

    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.packageDir).toBe(resolve(packageDir));
  });

  it("ignores default exports and skips invalid named exports without crashing", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-discovery-tests", `${task.id}-invalid`);
    await mkdir(cwd, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: {
        "@acme/trailstep-workflows": "1.0.0",
      },
    });
    await createWorkflowPackage(cwd);

    const workflows = await discoverWorkflows({ cwd });

    expect(workflows.map((workflow) => workflow.id)).toEqual([
      "@acme/trailstep-workflows:reviewFeature",
    ]);
  });
});
