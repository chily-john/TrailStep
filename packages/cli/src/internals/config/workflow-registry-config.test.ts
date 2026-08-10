import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStepKitProjectConfig } from "./config.js";

async function writeConfig(cwd: string, value: unknown): Promise<void> {
  await mkdir(join(cwd, ".stepkit"), { recursive: true });
  await writeFile(
    join(cwd, ".stepkit", "config.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function writeLocalConfig(cwd: string, value: unknown): Promise<void> {
  await mkdir(join(cwd, ".stepkit"), { recursive: true });
  await writeFile(
    join(cwd, ".stepkit", "config-local.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function writeUserConfig(homeDir: string, value: unknown): Promise<void> {
  await mkdir(join(homeDir, ".stepkit"), { recursive: true });
  await writeFile(
    join(homeDir, ".stepkit", "config.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

describe("workflow registry project config", () => {
  it("parses string-valued project workflow registrations without losing agent config", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-registry-config-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeConfig(cwd, {
      version: 1,
      customProviders: {
        local: { binary: "pi", args: ["--model", "small"] },
      },
      agents: {
        small: [{ provider: "local" }],
      },
      workflows: {
        project: {
          release: "./.stepkit/workflows/release.mjs",
        },
        review: {
          agents: {
            reviewer: [{ provider: "local", model: "small" }],
          },
        },
      },
    });

    await expect(loadStepKitProjectConfig(cwd)).resolves.toMatchObject({
      workflowRegistry: {
        project: {
          release: "./.stepkit/workflows/release.mjs",
        },
      },
      stepkitConfig: {
        workflows: {
          review: {
            agents: {
              reviewer: [{ provider: "local", model: "small" }],
            },
          },
        },
      },
    });
  });

  it("merges global, project, and local run config with agents replaced by entry name", async ({
    task,
  }) => {
    const root = join("node_modules", ".tmp-trailstep-workflow-registry-config-tests", task.id);
    const cwd = join(root, "project");
    const homeDir = join(root, "home");
    await rm(root, { recursive: true, force: true });

    await writeUserConfig(homeDir, {
      version: 1,
      customProviders: {
        user: { binary: "user-pi" },
      },
      agents: {
        default: [{ provider: "claude", args: ["--user-default"] }],
        userOnly: [{ provider: "claude" }],
      },
    });
    await writeConfig(cwd, {
      customProviders: {
        project: { binary: "project-pi" },
      },
      agents: {
        default: [{ provider: "codex", args: ["--project-default"] }],
        projectOnly: [{ provider: "codex" }],
      },
    });
    await writeLocalConfig(cwd, {
      customProviders: {
        local: { binary: "local-pi" },
      },
      agents: {
        default: [{ provider: "local", args: ["--local-default"] }],
        localOnly: [{ provider: "local" }],
      },
    });

    await expect(loadStepKitProjectConfig(cwd, { homeDir })).resolves.toMatchObject({
      stepkitConfig: {
        customProviders: {
          local: { binary: "local-pi" },
        },
        agents: {
          default: [{ provider: "local", args: ["--local-default"] }],
          userOnly: [{ provider: "claude" }],
          projectOnly: [{ provider: "codex" }],
          localOnly: [{ provider: "local" }],
        },
      },
    });
  });

  it("replaces top-level workflows for run config while keeping registry scopes merged", async ({
    task,
  }) => {
    const root = join("node_modules", ".tmp-trailstep-workflow-registry-config-tests", task.id);
    const cwd = join(root, "project");
    const homeDir = join(root, "home");
    await rm(root, { recursive: true, force: true });

    await writeUserConfig(homeDir, {
      version: 1,
      agents: {
        reviewer: [{ provider: "claude" }],
      },
      workflows: {
        userWorkflow: {
          agents: {
            reviewer: [{ provider: "claude", model: "user-model" }],
          },
        },
      },
    });
    await writeConfig(cwd, {
      agents: {
        reviewer: [{ provider: "codex" }],
      },
      workflows: {
        project: {
          release: "./release.mjs",
        },
        projectWorkflow: {
          agents: {
            reviewer: [{ provider: "codex", model: "project-model" }],
          },
        },
      },
    });
    await writeLocalConfig(cwd, {
      workflows: {
        project: {
          review: "./review.mjs",
        },
        localWorkflow: {
          agents: {
            reviewer: [{ provider: "codex", model: "local-model" }],
          },
        },
      },
    });

    const loaded = await loadStepKitProjectConfig(cwd, { homeDir });

    expect(loaded.workflowRegistry).toEqual({
      project: {
        release: "./release.mjs",
        review: "./review.mjs",
      },
    });
    expect(loaded.stepkitConfig?.workflows?.localWorkflow?.agents?.reviewer).toEqual([
      { provider: "codex", model: "local-model" },
    ]);
    expect(loaded.stepkitConfig?.workflows).not.toHaveProperty("userWorkflow");
    expect(loaded.stepkitConfig?.workflows).not.toHaveProperty("projectWorkflow");
  });

  it("merges config-local.json over config.json, with local winning per top-level key", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-registry-config-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeConfig(cwd, {
      version: 1,
      customProviders: {
        shared: { binary: "pi" },
        local: { binary: "pi", args: ["--model", "small"] },
      },
      agents: {
        small: [{ provider: "shared" }],
      },
    });
    await writeLocalConfig(cwd, {
      agents: {
        small: [{ provider: "local" }],
      },
    });

    await expect(loadStepKitProjectConfig(cwd)).resolves.toMatchObject({
      stepkitConfig: {
        customProviders: {
          shared: { binary: "pi" },
          local: { binary: "pi", args: ["--model", "small"] },
        },
        agents: {
          small: [{ provider: "local" }],
        },
      },
    });
  });

  it("merges workflows per-namespace instead of replacing the shared registry wholesale", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-registry-config-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeConfig(cwd, {
      workflows: {
        project: {
          release: "./release.mjs",
        },
      },
    });
    await writeLocalConfig(cwd, {
      workflows: {
        project: {
          review: "./review.mjs",
        },
      },
    });

    await expect(loadStepKitProjectConfig(cwd)).resolves.toMatchObject({
      workflowRegistry: {
        project: {
          release: "./release.mjs",
          review: "./review.mjs",
        },
      },
    });
  });

  it("lets config-local.json win on a same-name workflow registration conflict", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-registry-config-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeConfig(cwd, {
      workflows: {
        project: {
          review: "./shared-review.mjs",
        },
      },
    });
    await writeLocalConfig(cwd, {
      workflows: {
        project: {
          review: "./local-review.mjs",
        },
      },
    });

    await expect(loadStepKitProjectConfig(cwd)).resolves.toMatchObject({
      workflowRegistry: {
        project: {
          review: "./local-review.mjs",
        },
      },
    });
  });

  it("loads config-local.json alone when config.json is absent", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-workflow-registry-config-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeLocalConfig(cwd, {
      customProviders: {
        local: { binary: "pi", args: ["--model", "small"] },
      },
      agents: {
        small: [{ provider: "local" }],
      },
    });

    await expect(loadStepKitProjectConfig(cwd)).resolves.toMatchObject({
      stepkitConfig: {
        agents: {
          small: [{ provider: "local" }],
        },
      },
    });
  });
});
