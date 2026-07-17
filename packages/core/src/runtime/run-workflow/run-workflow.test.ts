import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, step } from "../../authoring/authoring.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";
import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";
import { runWorkflow } from "./run-workflow.js";

describe("runWorkflow runtime front-door", () => {
  it("persists step events before the event sink observes a later event", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));
    let eventsAtFirstStepCompletion: readonly Event[] = [];

    const firstStep = step({ id: "first", outputShape: { value: "number" } }).next(
      (input: { value: number }) => secondStep({ value: input.value + 1 }),
    );

    const secondStep = step({ id: "second", outputShape: { value: "number" } }).next(
      (input: { value: number }) => done({ value: input.value + 1 }),
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
