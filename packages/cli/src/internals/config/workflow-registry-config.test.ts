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

describe("workflow registry project config", () => {
  it("parses string-valued project workflow registrations without losing agent config", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-workflow-registry-config-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeConfig(cwd, {
      version: 1,
      customAgents: {
        local: { binary: "pi", args: ["--model", "small"] },
      },
      workingAgents: {
        small: [{ provider: "local" }],
      },
      interactiveAgents: {},
      workflows: {
        project: {
          release: "./.stepkit/workflows/release.mjs",
        },
        review: {
          workingAgents: {
            reviewer: [{ provider: "local", size: "small" }],
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
            workingAgents: {
              reviewer: [{ provider: "local" }],
            },
          },
        },
      },
    });
  });

  it("merges config-local.json over config.json, with local winning per top-level key", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-workflow-registry-config-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeConfig(cwd, {
      version: 1,
      customAgents: {
        shared: { binary: "pi" },
        local: { binary: "pi", args: ["--model", "small"] },
      },
      workingAgents: {
        small: [{ provider: "shared" }],
      },
    });
    await writeLocalConfig(cwd, {
      workingAgents: {
        small: [{ provider: "local" }],
      },
    });

    await expect(loadStepKitProjectConfig(cwd)).resolves.toMatchObject({
      stepkitConfig: {
        customAgents: {
          shared: { binary: "pi" },
        },
        workingAgents: {
          small: [{ provider: "local" }],
        },
      },
    });
  });

  it("merges workflows per-namespace instead of replacing the shared registry wholesale", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-workflow-registry-config-tests", task.id);
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
    const cwd = join("node_modules", ".tmp-stepkit-workflow-registry-config-tests", task.id);
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
    const cwd = join("node_modules", ".tmp-stepkit-workflow-registry-config-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeLocalConfig(cwd, {
      customAgents: {
        local: { binary: "pi", args: ["--model", "small"] },
      },
      workingAgents: {
        small: [{ provider: "local" }],
      },
    });

    await expect(loadStepKitProjectConfig(cwd)).resolves.toMatchObject({
      stepkitConfig: {
        workingAgents: {
          small: [{ provider: "local" }],
        },
      },
    });
  });
});
