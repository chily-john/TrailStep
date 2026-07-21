import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StepKitConfig } from "@stepkit/core";
import { runWorkflow } from "@stepkit/core";
import { describe, expect, it } from "vitest";
import { dailyNote } from "./daily-note.js";

describe("dailyNote workflow", () => {
  it("dispatches the write-note step to the configured claude working agent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-create-flows-daily-note-test-"));

    const stepkitConfig: StepKitConfig = {
      version: 1,
      customAgents: {},
      workingAgents: { default: [{ provider: "claude" }] },
      interactiveAgents: { default: [] },
    };

    const result = await runWorkflow({
      workflow: dailyNote,
      input: {},
      runName: "daily-note-test",
      cwd,
      stepkitConfig,
      providerWorkingRunner: async ({ args }) => {
        expect(args).toContain("--dangerously-skip-permissions");
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: JSON.stringify({ isDone: true }) }),
        };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ isDone: true });
  });
});
