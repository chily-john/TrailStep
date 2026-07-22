import { describe, expect, it } from "vitest";

import { done, step } from "../../../authoring/authoring.js";
import type { Event } from "../../../runtime/run-workflow/run-workflow.types.js";
import { createEvent } from "../../events/create-run-event.js";
import { createRunContext } from "../../run-context/create-run-context.js";
import { runContinuation } from "./run-continuation.js";

describe("runContinuation", () => {
  it("still requires outputShape for working prompted steps", async () => {
    const result = await runContinuation({
      node: step({ id: "draft", agent: "writer" }).prompt("Draft the plan.").next(done)({}),
      runId: "working-missing-output-shape-run",
      workflowId: "working-missing-output-shape-workflow",
      emit: async () => {},
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: { writer: { size: "small" } },
      runDir: ".",
      cwd: process.cwd(),
      runContext: createRunContext({
        runId: "working-missing-output-shape-run",
        runName: "working-missing-output-shape-run",
        runDir: ".",
      }),
      stepkitConfig: {
        version: 1,
        customAgents: {},
        workingAgents: {},
        interactiveAgents: {},
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected runContinuation to fail.");
    }
    expect(result.failure.message).toContain("requires an outputShape");
  });

  it("routes a thrown step error through an error continuation to done", async () => {
    const events: Event[] = [];
    const runId = "recover-thrown-step-error-run";
    const workflowId = "recover-thrown-step-error-workflow";

    events.push(
      createEvent({
        runId,
        workflowId,
        type: "workflow.started",
        payload: { input: { value: 1 } },
      }),
    );

    const firstNode = step({
      id: "explode",
      outputShape: { value: "number" },
    })
      .next(() => {
        throw new Error("Boom");
      })
      .catch((error) => done({ status: "failed", summary: error.message }))({ value: 1 });

    const result = await runContinuation({
      node: firstNode,
      runId,
      workflowId,
      emit: async (event) => {
        events.push(event);
      },
      maxSteps: 1000,
      initialSource: `workflow.start for workflow ${workflowId}`,
      workflowAgents: {},
      runDir: ".",
      cwd: process.cwd(),
      runContext: createRunContext({ runId, runName: runId, runDir: "." }),
    });

    expect(result).toEqual({
      status: "success",
      output: { status: "failed", summary: "Boom" },
    });

    if (result.status === "success") {
      events.push(
        createEvent({
          runId,
          workflowId,
          type: "workflow.completed",
          payload: { output: result.output },
        }),
      );
    }

    expect(events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.completed",
    ]);
    expect(events[3]).toMatchObject({
      payload: { output: { status: "failed", summary: "Boom" } },
    });
  });
});
