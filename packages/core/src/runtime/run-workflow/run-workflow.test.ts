import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, fail, notify, step, workflow as workflowInput } from "../../authoring/authoring.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";
import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";
import { runWorkflow } from "./run-workflow.js";

async function reportCreatedWorktree(path: string): Promise<void> {
  await notify.progress("Created worktree", { path });
}

describe("runWorkflow runtime front-door", () => {
  it("lets steps read immutable workflow input through the ambient workflow API", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-workflow-input-"));
    type Input = { task: string; nested: { count: number } };
    const typedWorkflow = workflowInput.withInput<Input>();
    const workflow: Workflow<Input, { task: string; count: number }> = {
      id: "ambient-workflow-input",
      input: {
        validate: (value): value is Input => typeof value === "object" && value !== null,
        diagnostics: () => [],
        assert: (value) => value as Input,
        jsonSchema: { type: "object" },
      },
      outputShape: { task: "string", count: "number" },
      start(input) {
        return step({ id: "read-input" }).do(async () => {
          const fullInput = await workflowInput.input<Input>();
          const directTask = await workflowInput.inputValue<Input, "task">("task");
          const task = await typedWorkflow.inputValue("task");
          try {
            (fullInput as { nested: { count: number } }).nested.count = 99;
          } catch {
            // Frozen input throws in strict ESM; either way, source input must remain unchanged.
          }
          const reread = await typedWorkflow.input();
          return done({ task: `${directTask}:${task}`, count: reread.nested.count });
        })(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "Investigate", nested: { count: 1 } },
      runName: "ambient-workflow-input-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ task: "Investigate:Investigate", count: 1 });
  });

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

  it("persists terminal messages on workflow completed and failed events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-terminal-message-"));
    const completeWorkflow: Workflow<{ task: string }, { ok: boolean }> = {
      id: "complete-message-events",
      inputShape: { task: "string" },
      outputShape: { ok: "boolean" },
      start(input) {
        return done({ ok: true }, { message: `Completed ${input.task}` });
      },
    };
    const failWorkflow: Workflow<{ task: string }, { ok: boolean }> = {
      id: "fail-message-events",
      inputShape: { task: "string" },
      outputShape: { ok: "boolean" },
      start(input) {
        return fail(
          { code: "task_failed", message: `Failed ${input.task}` },
          { message: `Cannot complete ${input.task}` },
        );
      },
    };

    const completed = await runWorkflow({
      workflow: completeWorkflow,
      input: { task: "handoff" },
      runName: "complete-message-run",
      cwd,
    });
    const failed = await runWorkflow({
      workflow: failWorkflow,
      input: { task: "handoff" },
      runName: "fail-message-run",
      cwd,
    });

    expect(completed.events.at(-1)).toMatchObject({
      type: "workflow.completed",
      payload: { output: { ok: true }, message: "Completed handoff" },
    });
    expect(failed.events.at(-1)).toMatchObject({
      type: "workflow.failed",
      payload: {
        failure: { code: "task_failed", message: "Failed handoff" },
        message: "Cannot complete handoff",
      },
    });
  });

  it("persists durable notify events emitted by code steps and helpers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-notify-"));
    const workflow: Workflow<{ path: string }, { ok: boolean }> = {
      id: "notify-events",
      inputShape: { path: "string" },
      outputShape: { ok: "boolean" },
      start(input) {
        return step({ id: "prepare" }).do(
          async (stepInput: { readonly path: string } & Record<string, unknown>) => {
            const { path } = stepInput;
            await notify.progress("Preparing worktree", { path });
            await reportCreatedWorktree(path);
            await notify.warning("Validation failed, retrying");
            await notify.artifact("Research notes", {
              path: "notes.md",
              mediaType: "text/markdown",
              data: { source: "research" },
            });
            return done({ ok: true });
          },
        )(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { path: "feature-worktree" },
      runName: "notify-events-run",
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
      "step.progress",
      "step.progress",
      "step.warning",
      "step.artifact",
      "step.completed",
      "workflow.completed",
    ]);
    expect(persistedEvents[2]).toMatchObject({
      stepId: "prepare",
      payload: { message: "Preparing worktree", data: { path: "feature-worktree" } },
    });
    expect(persistedEvents[3]).toMatchObject({
      stepId: "prepare",
      payload: { message: "Created worktree", data: { path: "feature-worktree" } },
    });
    expect(persistedEvents[4]).toMatchObject({
      stepId: "prepare",
      payload: { message: "Validation failed, retrying" },
    });
    expect(persistedEvents[5]).toMatchObject({
      stepId: "prepare",
      payload: {
        name: "Research notes",
        path: "notes.md",
        mediaType: "text/markdown",
        data: { source: "research" },
      },
    });
  });

  it("throws clearly when notify is called outside a TrailStep run", async () => {
    await expect(notify.progress("No active run")).rejects.toThrow(
      "notify.* called outside an active TrailStep run.",
    );
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

  it("completes a check wait immediately", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-check-wait-done-"));
    let checkCalls = 0;
    const workflow: Workflow<{ sha: string }, { status: string; url: string }> = {
      id: "check-wait-done",
      inputShape: { sha: "string" },
      outputShape: { status: "string", url: "string" },
      start(input) {
        return step({ id: "ci" })
          .wait(
            async ({ input, wait }) => {
              checkCalls += 1;
              return wait.done({ status: "passed", url: `https://ci.example/${input.sha}` });
            },
            { output: { status: "string", url: "string" } },
          )
          .do(({ waits }) => {
            const result = waits["check-0"] as { status: string; url: string } | undefined;
            return done({ status: result?.status ?? "missing", url: result?.url ?? "missing" });
          })(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { sha: "abc123" },
      runName: "check-wait-done-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(checkCalls).toBe(1);
    expect(result.output).toEqual({ status: "passed", url: "https://ci.example/abc123" });
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "wait.satisfied",
      "step.completed",
      "workflow.completed",
    ]);
    expect(result.events[2]).toMatchObject({
      payload: { waitId: "check-0", kind: "check", output: result.output },
    });
  });

  it("reruns a pending check wait on continue and completes later", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-check-wait-pending-"));
    let checkCalls = 0;
    const workflow: Workflow<{ sha: string }, { status: string }> = {
      id: "check-wait-pending",
      inputShape: { sha: "string" },
      outputShape: { status: "string" },
      start(input) {
        return step({ id: "ci" })
          .wait(
            async ({ wait }) => {
              checkCalls += 1;
              if (checkCalls === 1) {
                return wait.pending({
                  id: "ci",
                  message: "Waiting for CI to pass",
                  retryAfterSeconds: 30,
                });
              }

              return wait.done({ status: "passed" });
            },
            { output: { status: "string" } },
          )
          .do(({ waits }) => done({ status: String(waits.ci?.status) }))(input);
      },
    };

    const first = await runWorkflow({
      workflow,
      input: { sha: "abc123" },
      runName: "check-wait-pending-run",
      cwd,
    });

    expect(first.status).toBe("waiting");
    if (first.status !== "waiting") {
      throw new Error("Expected first run to wait.");
    }
    expect(checkCalls).toBe(1);
    expect(first.wait).toMatchObject({
      stepId: "ci",
      waitId: "ci",
      message: "Waiting for CI to pass",
    });
    expect(first.events.at(-1)).toMatchObject({
      type: "wait.started",
      payload: { kind: "check", retryAfterSeconds: 30 },
    });
    await expect(
      readFile(join(first.runDir, first.wait.artifactPaths.requestFile), "utf8"),
    ).resolves.toContain('"retryAfterSeconds": 30');

    const second = await runWorkflow({
      workflow,
      continue: { runDir: first.runDir },
      cwd,
    });

    expect(second.status).toBe("success");
    if (second.status !== "success") {
      throw new Error(second.failure.message);
    }
    expect(checkCalls).toBe(2);
    expect(second.output).toEqual({ status: "passed" });
    expect(second.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "wait.started",
      "workflow.resumed",
      "wait.satisfied",
      "step.completed",
      "workflow.completed",
    ]);
  });

  it("turns thrown check wait errors into clear failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-check-wait-error-"));
    const workflow: Workflow<{ sha: string }, { ok: boolean }> = {
      id: "check-wait-error",
      inputShape: { sha: "string" },
      outputShape: { ok: "boolean" },
      start(input) {
        return step({ id: "ci" })
          .wait(
            async () => {
              throw new Error("CI API unavailable");
            },
            { output: { ok: "boolean" } },
          )
          .do(() => done({ ok: true }))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { sha: "abc123" },
      runName: "check-wait-error-run",
      cwd,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected check wait to fail.");
    }
    expect(result.failure.message).toContain("CI API unavailable");
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "wait.failed",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it("schema-validates check wait output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-check-wait-schema-"));
    const workflow: Workflow<{ sha: string }, { status: string }> = {
      id: "check-wait-schema",
      inputShape: { sha: "string" },
      outputShape: { status: "string" },
      start(input) {
        return step({ id: "ci" })
          .wait(async ({ wait }) => wait.done({ status: 200 } as never), {
            output: { status: "string" },
          })
          .do(() => done({ status: "unreachable" }))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { sha: "abc123" },
      runName: "check-wait-schema-run",
      cwd,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected check wait to fail validation.");
    }
    expect(result.failure.message).toContain(
      "step ci check wait check-0 output failed schema validation",
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "wait.failed",
      "step.failed",
      "workflow.failed",
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
