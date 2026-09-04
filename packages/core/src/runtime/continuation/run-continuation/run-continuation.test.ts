import { describe, expect, it } from "vitest";

import { done, jsonSchema, step } from "../../../authoring/authoring.js";
import type { Event } from "../../../runtime/run-workflow/run-workflow.types.js";
import { createEvent } from "../../events/create-run-event.js";
import { runContinuation } from "./run-continuation.js";

describe("runContinuation", () => {
  it("runs an existing prompted step through prompt and do phases without changing events or values", async () => {
    const events: Event[] = [];
    const output = jsonSchema<{ readonly answer: string } & Record<string, unknown>>({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    });
    const doCalls: Array<{
      readonly output: { readonly answer: string } & Record<string, unknown>;
      readonly input: { readonly question: string } & Record<string, unknown>;
    }> = [];

    const node = step({ id: "answer" })
      .prompt<
        { readonly question: string } & Record<string, unknown>,
        { readonly answer: string } & Record<string, unknown>
      >(({ input }) => `Answer ${input.question}.`, {
        output,
        adapter: async ({ messages, tools }) => {
          expect(messages[0]?.content).toBe("Answer phase refactor?.");
          await tools[0]?.call({ answer: "yes" });
        },
      })
      .do((agentOutput, stepInput) => {
        doCalls.push({ output: agentOutput, input: stepInput });
        return done({ summary: `${stepInput.question} ${agentOutput.answer}` });
      })({ question: "phase refactor?" });

    expect(node.phases?.map((phase) => phase.kind)).toEqual(["prompt", "do"]);

    const result = await runContinuation({
      node,
      runId: "prompted-phase-regression-run",
      workflowId: "prompted-phase-regression-workflow",
      emit: async (event) => {
        events.push(event);
      },
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: {},
      runDir: ".",
      cwd: process.cwd(),
    });

    expect(result).toEqual({
      status: "success",
      output: { summary: "phase refactor? yes" },
    });
    expect(doCalls).toEqual([
      { output: { answer: "yes" }, input: { question: "phase refactor?" } },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "step.started",
      "agent.toolCall",
      "step.completed",
    ]);
    expect(events[0]).toMatchObject({ payload: { kind: "agent" } });
    expect(events[2]).toMatchObject({ payload: { output: { answer: "yes" } } });
  });

  it("runs an existing code step as a do phase without changing completion events", async () => {
    const events: Event[] = [];
    const node = step({ id: "prepare" }).do(
      (input: { readonly value: number } & Record<string, unknown>, secondArg) => {
        expect(secondArg).toEqual(input);
        return done({ value: input.value + 1 });
      },
    )({ value: 41 });

    expect(node.phases?.map((phase) => phase.kind)).toEqual(["do"]);

    const result = await runContinuation({
      node,
      runId: "code-phase-regression-run",
      workflowId: "code-phase-regression-workflow",
      emit: async (event) => {
        events.push(event);
      },
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: {},
      runDir: ".",
      cwd: process.cwd(),
    });

    expect(result).toEqual({ status: "success", output: { value: 42 } });
    expect(events.map((event) => event.type)).toEqual(["step.started", "step.completed"]);
    expect(events[0]).toMatchObject({ payload: { kind: "code" } });
    expect(events[1]).toMatchObject({ payload: {} });
  });

  it("keeps display and wait as ordered no-op phases around existing code steps", async () => {
    const node = step({ id: "decorated" })
      .display("starting")
      .wait({ reason: "future hook" })
      .display("before work")
      .do((input: { readonly ok: boolean } & Record<string, unknown>) => done(input))
      .display("after work")({ ok: true });

    expect(node.phases?.map((phase) => phase.kind)).toEqual([
      "display",
      "wait",
      "display",
      "do",
      "display",
    ]);

    const result = await runContinuation({
      node,
      runId: "decorated-phase-run",
      workflowId: "decorated-phase-workflow",
      emit: async () => {},
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: {},
      runDir: ".",
      cwd: process.cwd(),
    });

    expect(result).toEqual({ status: "success", output: { ok: true } });
  });

  it("still requires an output shape for working prompted steps", async () => {
    const result = await runContinuation({
      node: step({ id: "draft" }).prompt("Draft the plan.", { agent: "writer" }).do(done)({}),
      runId: "working-missing-output-shape-run",
      workflowId: "working-missing-output-shape-workflow",
      emit: async () => {},
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: { writer: { size: "small" } },
      runDir: ".",
      cwd: process.cwd(),
      trailstepConfig: {
        version: 1,
        customProviders: {},
        agents: {},
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected runContinuation to fail.");
    }
    expect(result.failure.message).toContain("requires an output shape");
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
    })
      .do(() => {
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
