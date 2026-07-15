import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverWorkflows } from "./discovery.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createWorkflowPackage(cwd: string): Promise<void> {
  const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
  await mkdir(packageDir, { recursive: true });
  await writeJson(join(packageDir, "package.json"), {
    name: "@acme/stepkit-workflows",
    version: "1.0.0",
    type: "module",
    main: "./index.mjs",
    keywords: ["stepkit-workflow"],
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
  it("discovers named continuation workflow exports from stepkit-workflow packages", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      type: "module",
      dependencies: {
        "@acme/stepkit-workflows": "1.0.0",
      },
    });
    await createWorkflowPackage(cwd);

    await expect(discoverWorkflows({ cwd })).resolves.toEqual([
      {
        id: "@acme/stepkit-workflows:reviewFeature",
        packageName: "@acme/stepkit-workflows",
        exportName: "reviewFeature",
        workflow: expect.objectContaining({ id: "reviewFeature" }),
      },
    ]);
  });

  it("ignores default exports and skips invalid named exports without crashing", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-tests", `${task.id}-invalid`);
    await mkdir(cwd, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: {
        "@acme/stepkit-workflows": "1.0.0",
      },
    });
    await createWorkflowPackage(cwd);

    const workflows = await discoverWorkflows({ cwd });

    expect(workflows.map((workflow) => workflow.id)).toEqual([
      "@acme/stepkit-workflows:reviewFeature",
    ]);
  });
});
