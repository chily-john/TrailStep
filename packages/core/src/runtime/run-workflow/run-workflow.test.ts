import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, step } from "../../authoring/authoring.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";
import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";
import { runWorkflow } from "./run-workflow.js";

describe("runWorkflow runtime front-door", () => {
  it("accepts an already-flattened non-empty StepKitConfig without reparsing it as raw entries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-flattened-config-"));
    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "flattened-config-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({ id: "review" })
          .prompt(({ input }) => `Review ${input.task}.`, {
            agent: "reviewer",
            output: { answer: "string" },
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "flattened config" },
      runName: "flattened-config-run",
      cwd,
      stepkitConfig: {
        version: 1,
        customProviders: { local: { binary: "local-agent" } },
        agents: { small: [{ provider: "local", model: "fast" }] },
      },
      workingAgentProcessRunner: async (request) => {
        await writeFile(request.outputFile, JSON.stringify({ answer: request.model }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ answer: "fast" });
  });

  it("persists step events before the event sink observes a later event", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));
    let eventsAtFirstStepCompletion: readonly Event[] = [];

    const firstStep = step({ id: "first" }).do((input: { value: number }) =>
      secondStep({ value: input.value + 1 }),
    );

    const secondStep = step({ id: "second" }).do((input: { value: number }) =>
      done({ value: input.value + 1 }),
    );

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "incremental-events",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return firstStep(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "incremental-events-run",
      cwd,
      eventSink: async (event) => {
        if (event.type !== "step.completed" || event.stepId !== "first") {
          return;
        }

        try {
          const contents = await readFile(
            join(cwd, ".stepkit", "runs", event.runId, "events.jsonl"),
            "utf8",
          );
          eventsAtFirstStepCompletion = contents
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Event);
        } catch {
          eventsAtFirstStepCompletion = [];
        }
      },
    });

    expect(result.status).toBe("success");
    expect(eventsAtFirstStepCompletion.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
    ]);
    expect(eventsAtFirstStepCompletion[2]?.stepId).toBe("first");
  });
});
