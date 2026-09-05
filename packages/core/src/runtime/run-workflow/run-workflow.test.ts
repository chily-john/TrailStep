import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, step } from "../../authoring/authoring.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";
import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";
import { runWorkflow } from "./run-workflow.js";

describe("runWorkflow runtime front-door", () => {
  it("accepts an already-flattened non-empty TrailStepConfig without reparsing it as raw entries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-flattened-config-"));
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
      trailstepConfig: {
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

  it("persists durable step.display events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-display-"));
    const workflow: Workflow<{ task: string }, { ok: boolean }> = {
      id: "display-events",
      inputShape: { task: "string" },
      outputShape: { ok: "boolean" },
      start(input) {
        return step({ id: "prepare" })
          .display(({ input }) => ({
            message: `Preparing ${input.task}`,
            data: { task: input.task },
          }))
          .do(() => done({ ok: true }))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "worktree" },
      runName: "display-events-run",
      cwd,
    });

    expect(result.status).toBe("success");
    const contents = await readFile(join(result.runDir, "events.jsonl"), "utf8");
    const persistedEvents = contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Event);

    expect(persistedEvents.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.display",
      "step.completed",
      "workflow.completed",
    ]);
    expect(persistedEvents[2]).toMatchObject({
      stepId: "prepare",
      payload: {
        message: "Preparing worktree",
        level: "info",
        data: { task: "worktree" },
        phaseIndex: 0,
      },
    });
  });

  it("pauses at a wait before a prompt without dispatching the prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-wait-before-prompt-"));
    const workflow: Workflow<{ task: string }, { ok: boolean }> = {
      id: "wait-before-prompt",
      inputShape: { task: "string" },
      outputShape: { ok: "boolean" },
      start(input) {
        return step({ id: "publish" })
          .wait({
            id: "approval",
            kind: "input",
            message: "Approve this change?",
            output: { approved: "boolean" },
          })
          .prompt("This should not run.", {
            output: { ok: "boolean" },
            adapter: async () => {
              throw new Error("prompt should not run before wait is answered");
            },
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "release" },
      runName: "wait-before-prompt-run",
      cwd,
    });

    expect(result.status).toBe("waiting");
    if (result.status !== "waiting") {
      throw new Error("Expected workflow to wait.");
    }
    expect(result.wait).toEqual({
      stepId: "publish",
      waitId: "approval",
      message: "Approve this change?",
      artifactPaths: {
        requestFile: "steps/0001-publish/waits/approval/request.json",
        answerFile: "steps/0001-publish/waits/approval/answer.json",
      },
    });
    await expect(
      readFile(join(result.runDir, result.wait.artifactPaths.requestFile), "utf8"),
    ).resolves.toContain("Approve this change?");
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "wait.started",
    ]);
  });

  it("pauses at a wait after a prompt and lets the wait callback read prompt output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-wait-after-prompt-"));
    const workflow: Workflow<{ task: string }, { final: string }> = {
      id: "wait-after-prompt",
      inputShape: { task: "string" },
      outputShape: { final: "string" },
      start(input) {
        return step({ id: "draft" })
          .prompt<{ task: string }, { draft: string }>(({ input }) => `Draft ${input.task}.`, {
            output: { draft: "string" },
            adapter: async ({ tools }) => {
              await tools[0]?.call({ draft: "v1" });
            },
          })
          .wait(({ output }) => ({
            id: "approval",
            kind: "input",
            message: `Approve ${output.draft}?`,
            output: { approved: "boolean" },
          }))
          .do((context) => {
            const waitContext = context as unknown as {
              readonly output: { readonly draft: string };
              readonly waits: { readonly approval?: { readonly approved?: boolean } };
            };
            return done({
              final: `${waitContext.output.draft}:${String(waitContext.waits.approval?.approved)}`,
            });
          })(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "copy" },
      runName: "wait-after-prompt-run",
      cwd,
    });

    expect(result.status).toBe("waiting");
    if (result.status !== "waiting") {
      throw new Error("Expected workflow to wait.");
    }
    expect(result.wait.message).toBe("Approve v1?");
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "agent.toolCall",
      "step.completed",
      "wait.started",
    ]);
  });

  it("persists step events before the event sink observes a later event", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-"));
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
            join(cwd, ".trailstep", "runs", event.runId, "events.jsonl"),
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
