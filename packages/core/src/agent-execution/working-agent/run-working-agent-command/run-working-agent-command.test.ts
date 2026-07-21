import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
  it("writes repeated working-agent outputs to distinct ordered step directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-working-agent-ordered-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "working-agent-ordered-artifacts-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "prepare" }).next(() =>
          step({ id: "review", outputShape: { answer: "string" }, agent: "reviewer" })
            .prompt(({ input }) => `First review for ${input.task}.`)
            .next((first) =>
              step({ id: "record" }).next(() =>
                step({ id: "review", outputShape: { answer: "string" }, agent: "reviewer" })
                  .prompt("Second review.")
                  .next((second) => done({ answer: `${first.answer}/${second.answer}` }))({}),
              )(first),
            )({ task: input.task }),
        )(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "repeat" },
      runName: "working-agent-ordered-artifacts-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: { worker: { binary: "worker-agent" } },
        workingAgents: { medium: [{ provider: "worker" }] },
        interactiveAgents: {},
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        await writeFile(
          request.outputFile,
          JSON.stringify({
            answer: request.outputFile.includes("0002-review") ? "first" : "second",
          }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const firstOutputFile = join(result.runDir, "steps", "0002-review", "output.json");
    const secondOutputFile = join(result.runDir, "steps", "0004-review", "output.json");
    expect(requests.map((request) => request.outputFile)).toEqual([
      firstOutputFile,
      secondOutputFile,
    ]);
    expect(firstOutputFile).not.toBe(secondOutputFile);
    await expect(readFile(firstOutputFile, "utf8")).resolves.toContain("first");
    await expect(readFile(secondOutputFile, "utf8")).resolves.toContain("second");
    await expect(readdir(join(result.runDir, "steps"))).resolves.toEqual([
      "0002-review",
      "0004-review",
    ]);
    await expect(
      readFile(join(result.runDir, "steps", "0002-review", "prompt.md"), "utf8"),
    ).resolves.toContain(firstOutputFile);
    expect(
      result.events.filter((event) => event.type === "step.started").map((event) => event.stepId),
    ).toEqual(["prepare", "review", "record", "review"]);
  });

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
