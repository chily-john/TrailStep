import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflowReference } from "./workflow-resolution.js";
import { WorkflowResolutionError } from "./workflow-resolution-error.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeProjectWorkflow(cwd: string): Promise<void> {
  await writeWorkflowFile(join(cwd, ".stepkit", "workflows"), "release", { released: true });
}

async function writeUserWorkflow(homeDir: string): Promise<void> {
  await writeWorkflowFile(join(homeDir, ".stepkit", "workflows"), "cleanup", { cleaned: true });
}

async function writeWorkflowFile(
  workflowDir: string,
  workflowName: string,
  output: Record<string, boolean>,
): Promise<void> {
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, `${workflowName}.mjs`),
    `const schema = {
      validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      diagnostics: () => [],
      assert: (value) => value,
    };
    export const ${workflowName} = {
      id: '${workflowName}',
      input: schema,
      output: schema,
      start: (input) => ({ kind: 'done', output: { ...input, ...${JSON.stringify(output)} } }),
    };`,
    "utf8",
  );
}

describe("registered workflow resolver", () => {
  it("resolves project/name from .stepkit/config.json to a direct workflow file relative to cwd", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });
    await writeProjectWorkflow(cwd);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: {
        project: {
          release: "./.stepkit/workflows/release.mjs",
        },
      },
    });

    await expect(resolveWorkflowReference("project/release", { cwd, homeDir })).resolves.toMatchObject({
      id: "project/release",
      workflow: { id: "release" },
      workflowRef: {
        kind: "direct-file",
        packageName: resolve(cwd, ".stepkit", "workflows", "release.mjs"),
      },
    });
  });

  it("resolves an unqualified name from the project namespace when present", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });
    await writeProjectWorkflow(cwd);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: {
        project: {
          release: "./.stepkit/workflows/release.mjs",
        },
      },
    });

    await expect(resolveWorkflowReference("release", { cwd, homeDir })).resolves.toMatchObject({
      id: "project/release",
      workflow: { id: "release" },
    });
  });

  it("resolves user/name from an injected home directory and expands ~ targets", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });
    await writeUserWorkflow(homeDir);
    await mkdir(join(homeDir, ".stepkit"), { recursive: true });
    await writeJson(join(homeDir, ".stepkit", "config.json"), {
      workflows: {
        user: {
          cleanup: "~/.stepkit/workflows/cleanup.mjs",
        },
      },
    });

    await expect(resolveWorkflowReference("user/cleanup", { cwd, homeDir })).resolves.toMatchObject({
      id: "user/cleanup",
      workflow: { id: "cleanup" },
      workflowRef: {
        kind: "direct-file",
        packageName: resolve(homeDir, ".stepkit", "workflows", "cleanup.mjs"),
      },
    });
  });

  it("names the requested registered ref when the namespace is missing", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeJson(join(cwd, ".stepkit", "config.json"), { workflows: { project: {} } });

    await expect(resolveWorkflowReference("team/release", { cwd, homeDir })).rejects.toThrow(
      new WorkflowResolutionError("Registered workflow namespace not found for ref: team/release"),
    );
  });
});
