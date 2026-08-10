import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflowReference } from "./workflow-resolution.js";
import { WorkflowResolutionError } from "./workflow-resolution-error.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeProjectWorkflow(cwd: string): Promise<void> {
  await writeWorkflowFile(join(cwd, ".trailstep", "workflows"), "release", { released: true });
}

async function writeUserWorkflow(homeDir: string): Promise<void> {
  await writeWorkflowFile(join(homeDir, ".trailstep", "workflows"), "cleanup", { cleaned: true });
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

async function writeBundleWorkflowPackage(
  packageDir: string,
  workflowName: string,
  exportName: string,
  packageName = "local-workflows",
): Promise<void> {
  await mkdir(packageDir, { recursive: true });
  await writeJson(join(packageDir, "package.json"), {
    name: packageName,
    type: "module",
    trailstep: { workflows: { [workflowName]: `./index.mjs#${exportName}` } },
  });
  await writeFile(
    join(packageDir, "index.mjs"),
    `const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };
    export const ${exportName} = { id: '${exportName}', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };`,
    "utf8",
  );
}

describe("registered workflow resolver", () => {
  it("resolves project/name from .trailstep/config.json to a direct workflow file relative to cwd", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });
    await writeProjectWorkflow(cwd);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: {
        project: {
          release: "./.trailstep/workflows/release.mjs",
        },
      },
    });

    await expect(
      resolveWorkflowReference("project/release", { cwd, homeDir }),
    ).resolves.toMatchObject({
      id: "project/release",
      workflow: { id: "release" },
      workflowRef: {
        kind: "direct-file",
        packageName: resolve(cwd, ".trailstep", "workflows", "release.mjs"),
      },
    });
  });

  it("dispatches direct-looking hash refs to the direct resolver before bundle parsing", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });

    await expect(
      resolveWorkflowReference("./workflows/missing.ts#release", { cwd, homeDir }),
    ).rejects.toThrow(/Direct workflow source not found:/);
  });

  it("preserves clean metadata for direct named exports", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });
    await writeWorkflowFile(join(cwd, "workflows"), "dailyNote", { released: true });

    await expect(
      resolveWorkflowReference("./workflows/dailyNote.mjs#dailyNote", { cwd, homeDir }),
    ).resolves.toMatchObject({
      id: `${resolve(cwd, "workflows", "dailyNote.mjs")}#dailyNote`,
      workflow: { id: "dailyNote" },
      workflowRef: {
        kind: "direct-file",
        packageName: resolve(cwd, "workflows", "dailyNote.mjs"),
        exportName: "dailyNote",
      },
    });
  });

  it("keeps bare package hash refs in bundle mode", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });
    await writeBundleWorkflowPackage(
      join(cwd, "node_modules", "@acme", "workflows"),
      "release",
      "releaseWorkflow",
      "@acme/workflows",
    );

    await expect(
      resolveWorkflowReference("@acme/workflows#release", { cwd, homeDir }),
    ).resolves.toMatchObject({
      id: "@acme/workflows#release",
      workflowRef: {
        kind: "bundle",
        packageName: "@acme/workflows",
        workflowName: "release",
      },
    });
  });

  it("keeps direct-looking package refs with bundle workflow manifests in bundle resolution", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });
    await writeBundleWorkflowPackage(join(cwd, "local-workflows"), "review", "reviewWorkflow");

    await expect(
      resolveWorkflowReference("./local-workflows#review", { cwd, homeDir }),
    ).resolves.toMatchObject({
      id: "./local-workflows#review",
      workflow: { id: "reviewWorkflow" },
      workflowRef: {
        kind: "bundle",
        packageName: "./local-workflows",
        workflowName: "review",
        exportName: "reviewWorkflow",
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
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: {
        project: {
          release: "./.trailstep/workflows/release.mjs",
        },
      },
    });

    await expect(resolveWorkflowReference("release", { cwd, homeDir })).resolves.toMatchObject({
      id: "project/release",
      workflow: { id: "release" },
    });
  });

  it("resolves global/name from an injected home directory and expands ~ targets", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "project");
    const homeDir = join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id, "home");
    await rm(join("node_modules", ".tmp-stepkit-registered-resolver-tests", task.id), {
      recursive: true,
      force: true,
    });
    await writeUserWorkflow(homeDir);
    await mkdir(join(homeDir, ".trailstep"), { recursive: true });
    await writeJson(join(homeDir, ".trailstep", "config.json"), {
      workflows: {
        global: {
          cleanup: "~/.trailstep/workflows/cleanup.mjs",
        },
      },
    });

    await expect(
      resolveWorkflowReference("global/cleanup", { cwd, homeDir }),
    ).resolves.toMatchObject({
      id: "global/cleanup",
      workflow: { id: "cleanup" },
      workflowRef: {
        kind: "direct-file",
        packageName: resolve(homeDir, ".trailstep", "workflows", "cleanup.mjs"),
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
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), { workflows: { project: {} } });

    await expect(resolveWorkflowReference("team/release", { cwd, homeDir })).rejects.toThrow(
      new WorkflowResolutionError("Registered workflow namespace not found for ref: team/release"),
    );
  });
});
