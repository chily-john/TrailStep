import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  done,
  parseStepKitConfig,
  runWorkflow,
  step,
  type Workflow,
  type WorkingAgentProcessRequest,
} from "../../../index.js";
import { runWorkingAgentCommand } from "./run-working-agent-command.js";

describe("runWorkingAgentCommand", () => {
  it("falls back to the next working target and reports exhausted attempts when all targets fail", async () => {
    expect(runWorkingAgentCommand).toBeTypeOf("function");

    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-working-agent-exhausted-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "working-agent-exhausted-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({
          id: "review",
          outputShape: { answer: "string" },
          agent: "reviewer",
        })
          .prompt(({ input }) => `Review ${input.task}.`)
          .next((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "fallback" },
      runName: "working-agent-exhausted-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: {
          first: { binary: "first-agent" },
          second: { binary: "second-agent" },
        },
        workingAgents: {
          medium: [
            { provider: "first", model: "first-model" },
            { provider: "second", model: "second-model" },
          ],
        },
        interactiveAgents: {},
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        if (request.model === "second-model") {
          await writeFile(request.outputFile, JSON.stringify({ wrong: "shape" }), "utf8");
          return { exitCode: 0 };
        }
        return { exitCode: 7 };
      },
    });

    expect(requests.map((request) => request.model)).toEqual(["first-model", "second-model"]);
    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected all working targets to fail");
    }
    expect(result.failure.code).toBe("agent_target_exhausted");
    expect(result.failure.details).toMatchObject({
      roleName: "reviewer",
      attempts: [
        { target: "first", model: "first-model", code: "agent_provider_failed" },
        { target: "second", model: "second-model", code: "validation_failed" },
      ],
    });
  });
});
