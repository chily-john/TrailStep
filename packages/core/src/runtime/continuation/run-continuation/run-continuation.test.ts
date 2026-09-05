import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("includes optional step title and description in step.started payload", async () => {
    const events: Event[] = [];
    const node = step({
      id: "delegate-turn",
      title: "Delegate turn",
      description: "Runs one continued delegate-agent turn.",
    })
      .prompt("Delegate the turn.", {
        output: jsonSchema<{ readonly summary: string } & Record<string, unknown>>({
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        }),
        adapter: async ({ tools }) => {
          await tools[0]?.call({ summary: "done" });
        },
      })
      .do(() => done({ ok: true }))({});

    const result = await runContinuation({
      node,
      runId: "step-metadata-run",
      workflowId: "step-metadata-workflow",
      emit: async (event) => {
        events.push(event);
      },
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: {},
      runDir: ".",
      cwd: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(events[0]).toMatchObject({
      stepId: "delegate-turn",
      payload: {
        stepName: "delegate-turn",
        title: "Delegate turn",
        description: "Runs one continued delegate-agent turn.",
        kind: "agent",
      },
    });
  });

  it("emits ordered display phases before prompt, after prompt, and after do", async () => {
    const events: Event[] = [];
    const trace: string[] = [];
    const output = jsonSchema<
      { readonly summary: string; readonly changedFiles: readonly string[] } & Record<
        string,
        unknown
      >
    >({
      type: "object",
      properties: {
        summary: { type: "string" },
        changedFiles: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "changedFiles"],
      additionalProperties: false,
    });

    const node = step({ id: "delegate-turn" })
      .display(async ({ input }) => {
        trace.push("display:before");
        return `Delegating: ${input.task}`;
      })
      .display("After first display")
      .prompt<
        { readonly task: string } & Record<string, unknown>,
        { readonly summary: string; readonly changedFiles: readonly string[] } & Record<
          string,
          unknown
        >
      >(({ input }) => `Handle ${input.task}.`, {
        output,
        adapter: async ({ messages, tools }) => {
          trace.push("prompt");
          expect(messages[0]?.content).toBe("Handle ordered display.");
          await tools[0]?.call({ summary: "Delegate summarized", changedFiles: ["a.ts"] });
        },
      })
      .display(({ output }) => {
        trace.push(`display:after-prompt:${output.summary}`);
        return {
          message: output.summary,
          data: { changedFiles: output.changedFiles },
        };
      })
      .do((agentOutput, stepInput) => {
        trace.push("do");
        return done({ summary: `${stepInput.task}: ${agentOutput.summary}` });
      })
      .display({ message: "Delegate turn finished", level: "warning" })({
      task: "ordered display",
    });

    expect(node.phases?.map((phase) => phase.kind)).toEqual([
      "display",
      "display",
      "prompt",
      "display",
      "do",
      "display",
    ]);

    const result = await runContinuation({
      node,
      runId: "display-phase-run",
      workflowId: "display-phase-workflow",
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
      output: { summary: "ordered display: Delegate summarized" },
    });
    expect(trace).toEqual([
      "display:before",
      "prompt",
      "display:after-prompt:Delegate summarized",
      "do",
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "step.started",
      "step.display",
      "step.display",
      "agent.toolCall",
      "step.completed",
      "step.display",
      "step.display",
    ]);
    expect(events.filter((event) => event.type === "step.display")).toEqual([
      expect.objectContaining({
        payload: { message: "Delegating: ordered display", level: "info", phaseIndex: 0 },
      }),
      expect.objectContaining({
        payload: { message: "After first display", level: "info", phaseIndex: 1 },
      }),
      expect.objectContaining({
        payload: {
          message: "Delegate summarized",
          level: "info",
          data: { changedFiles: ["a.ts"] },
          phaseIndex: 3,
        },
      }),
      expect.objectContaining({
        payload: { message: "Delegate turn finished", level: "warning", phaseIndex: 5 },
      }),
    ]);
  });

  it("fails clearly when a display callback returns an invalid value", async () => {
    const events: Event[] = [];
    const node = step({ id: "bad-display" })
      .display(() => 123 as never)
      .do(() => done({ ok: true }))({});

    const result = await runContinuation({
      node,
      runId: "bad-display-run",
      workflowId: "bad-display-workflow",
      emit: async (event) => {
        events.push(event);
      },
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: {},
      runDir: ".",
      cwd: process.cwd(),
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected runContinuation to fail.");
    }
    expect(result.failure.message).toContain(
      "step bad-display display phase 0 must resolve to a string or an object with a string message",
    );
    expect(events.map((event) => event.type)).toEqual(["step.started", "step.failed"]);
  });

  it("makes multiple satisfied wait outputs addressable by id in do", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "trailstep-core-multiple-waits-"));
    const approvalDir = join(runDir, "steps", "0001-review", "waits", "approval");
    const ticketDir = join(runDir, "steps", "0001-review", "waits", "ticket");
    await mkdir(approvalDir, { recursive: true });
    await mkdir(ticketDir, { recursive: true });
    await writeFile(join(approvalDir, "answer.json"), JSON.stringify({ approved: true }), "utf8");
    await writeFile(join(ticketDir, "answer.json"), JSON.stringify({ ticket: "OPS-1" }), "utf8");
    const events: Event[] = [];
    const node = step({ id: "review" })
      .wait({
        id: "approval",
        kind: "input",
        message: "Approve?",
        output: { approved: "boolean" },
      })
      .wait({
        id: "ticket",
        kind: "input",
        message: "Ticket?",
        output: { ticket: "string" },
      })
      .do(({ waits }) =>
        done({ approved: waits.approval?.approved, ticket: waits.ticket?.ticket }),
      )({});

    const result = await runContinuation({
      node,
      runId: "multiple-waits-run",
      workflowId: "multiple-waits-workflow",
      emit: async (event) => {
        events.push(event);
      },
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: {},
      runDir,
      cwd: process.cwd(),
    });

    expect(result).toEqual({ status: "success", output: { approved: true, ticket: "OPS-1" } });
    expect(events.map((event) => event.type)).toEqual([
      "step.started",
      "wait.satisfied",
      "wait.satisfied",
      "step.completed",
    ]);
  });

  it("fails clearly when a step reaches duplicate wait ids", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "trailstep-core-duplicate-wait-"));
    const answerDir = join(runDir, "steps", "0001-review", "waits", "approval");
    await mkdir(answerDir, { recursive: true });
    await writeFile(join(answerDir, "answer.json"), JSON.stringify({ approved: true }), "utf8");
    const node = step({ id: "review" })
      .wait({
        id: "approval",
        kind: "input",
        message: "First approval?",
        output: { approved: "boolean" },
      })
      .wait({
        id: "approval",
        kind: "input",
        message: "Second approval?",
        output: { approved: "boolean" },
      })
      .do(() => done({ ok: true }))({});

    const result = await runContinuation({
      node,
      runId: "duplicate-wait-run",
      workflowId: "duplicate-wait-workflow",
      emit: async () => {},
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: {},
      runDir,
      cwd: process.cwd(),
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected runContinuation to fail.");
    }
    expect(result.failure.message).toContain("duplicate wait id 'approval'");
  });

  it("fails clearly when a wait is missing an output shape", async () => {
    const result = await runContinuation({
      node: step({ id: "approval" })
        .wait({ id: "approval", kind: "input", message: "Approve?" } as never)
        .do(() => done({ ok: true }))({}),
      runId: "missing-wait-output-run",
      workflowId: "missing-wait-output-workflow",
      emit: async () => {},
      maxSteps: 1000,
      initialSource: "test",
      workflowAgents: {},
      runDir: await mkdtemp(join(tmpdir(), "trailstep-core-missing-wait-output-")),
      cwd: process.cwd(),
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected runContinuation to fail.");
    }
    expect(result.failure.message).toContain("requires an output shape");
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
