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
});
