import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, step } from "../../../authoring/authoring.js";
import type { Workflow } from "../../../authoring/workflow/workflow.types.js";
import type { Event } from "../../../runtime/run-workflow/run-workflow.types.js";
import { appendEvent, createRunDirectory, readRunEvents } from "../../artifacts/run-storage.js";
import { runWorkflow } from "../../run-workflow/run-workflow.js";
import { replayToFailedStep } from "./replay-to-failed-step.js";

function eventTypes(events: readonly Event[]): readonly string[] {
  return events.map((event) => event.type);
}

function event(overrides: Partial<Event> & Pick<Event, "id" | "type">): Event {
  return {
    runId: "history-run",
    workflowId: "history-workflow",
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: {},
    ...overrides,
  };
}

async function createRunWithEvents(events: readonly Event[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
  const { runDir } = await createRunDirectory({ cwd, runName: "history-run" });

  for (const nextEvent of events) {
    await appendEvent(runDir, nextEvent);
  }

  return runDir;
}

function replayWorkflow(): Workflow<{ value: number }, { value: number }> {
  const secondStep = step({
    id: "second",
  }).do(({ value }: { value: number }) => done({ value: value + 1 }));

  const firstStep = step({
    id: "first",
  }).do(({ value }: { value: number }) => secondStep({ value: value + 1 }));

  return {
    id: "history-workflow",
    inputShape: { value: "number" },
    outputShape: { value: "number" },
    start(input) {
      return firstStep(input);
    },
  };
}

describe("replayToFailedStep", () => {
  it("resumes a failed two-step run by replaying the completed first step from its recorded position", async () => {
    expect(typeof replayToFailedStep).toBe("function");
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
    let firstStepRuns = 0;
    let shouldFailSecondStep = true;

    const secondStep = step({
      id: "second",
    }).do(({ value }: { value: number }) => {
      if (shouldFailSecondStep) {
        throw new Error("second step unavailable");
      }

      return done({ value: value + 1 });
    });

    const firstStep = step({
      id: "first",
    }).do(({ value }: { value: number }) => {
      firstStepRuns += 1;
      return secondStep({ value: value + 1 });
    });

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "resumable-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return firstStep(input);
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "resume-me",
      cwd,
    });

    expect(failed.status).toBe("failure");
    expect(firstStepRuns).toBe(1);

    shouldFailSecondStep = false;
    const resumed = await runWorkflow({ workflow, resume: { runDir: failed.runDir } });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      throw new Error(resumed.failure.message);
    }

    expect(resumed.runId).toBe(failed.runId);
    expect(resumed.runDir).toBe(failed.runDir);
    expect(resumed.output).toEqual({ value: 3 });
    // A no-prompt step's .do(...) is both its computation and its continuation
    // decision fused into one closure — unlike the old separate run()'s plain,
    // serializable output, there is nothing to persist and feed back in its place.
    // Resuming past a completed no-prompt step therefore re-invokes its .do(...)
    // (from the same input) rather than skipping it, so firstStepRuns goes to 2.
    expect(firstStepRuns).toBe(2);
    expect(eventTypes(resumed.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.failed",
      "workflow.failed",
      "workflow.resumed",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(resumed.events[6]).toMatchObject({
      type: "workflow.resumed",
      payload: {
        resumedFromRunDir: failed.runDir,
        resumedStepId: "second",
        sourceFailureEventId: failed.events[4]?.id,
      },
    });

    const persistedEvents = (await readFile(join(failed.runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Event);
    expect(eventTypes(persistedEvents)).toEqual(eventTypes(resumed.events));
  });

  it("rejects a missing target with a specific failure code", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
    const missingRunDir = join(cwd, ".stepkit", "runs", "missing-run");

    const result = await runWorkflow({
      workflow: replayWorkflow(),
      resume: { runDir: missingRunDir },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected missing target resume to fail.");
    }
    expect(result.runId).toBe("missing-run");
    expect(result.runDir).toBe(missingRunDir);
    expect(result.events).toEqual([]);
    expect(result.failure.code).toBe("resume_target_not_found");
  });

  it("rejects unsupported failed histories with specific failure codes", async () => {
    const workflow = replayWorkflow();

    const cases: readonly {
      readonly name: string;
      readonly events: readonly Event[];
      readonly code: string;
    }[] = [
      {
        name: "multiple failed steps",
        code: "resume_multiple_failed_steps",
        events: [
          event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
          event({ id: "first-started", type: "step.started", stepId: "first" }),
          event({ id: "first-failed", type: "step.failed", stepId: "first" }),
          event({ id: "second-started", type: "step.started", stepId: "second" }),
          event({ id: "second-failed", type: "step.failed", stepId: "second" }),
          event({ id: "workflow-failed", type: "workflow.failed" }),
        ],
      },
      {
        name: "recovered onError flows",
        code: "resume_unsupported_history",
        events: [
          event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
          event({ id: "first-started", type: "step.started", stepId: "first" }),
          event({ id: "first-failed", type: "step.failed", stepId: "first" }),
          event({
            id: "first-recovered-completed",
            type: "step.completed",
            stepId: "first",
            payload: { output: { value: 2 } },
          }),
          event({ id: "second-started", type: "step.started", stepId: "second" }),
          event({ id: "second-failed", type: "step.failed", stepId: "second" }),
          event({ id: "workflow-failed", type: "workflow.failed" }),
        ],
      },
      {
        name: "step id drift",
        code: "resume_step_id_drift",
        events: [
          event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
          event({ id: "renamed-started", type: "step.started", stepId: "renamed-first" }),
          event({
            id: "renamed-completed",
            type: "step.completed",
            stepId: "renamed-first",
            payload: { output: { value: 2 } },
          }),
          event({ id: "second-started", type: "step.started", stepId: "second" }),
          event({ id: "second-failed", type: "step.failed", stepId: "second" }),
          event({ id: "workflow-failed", type: "workflow.failed" }),
        ],
      },
    ];

    for (const testCase of cases) {
      const runDir = await createRunWithEvents(testCase.events);
      const result = await runWorkflow({ workflow, resume: { runDir } });

      expect(result.status, testCase.name).toBe("failure");
      if (result.status !== "failure") {
        throw new Error(`Expected ${testCase.name} resume to fail.`);
      }
      expect(result.failure.code, testCase.name).toBe(testCase.code);
    }
  });

  it("resumes through a completed no-prompt orchestration-only step", async () => {
    // There is no separate "orchestration step" kind — a step with no .prompt(...) is
    // always just a no-prompt step, whether its .do(...) does arithmetic or pure
    // branching. Resume treats every no-prompt step identically (only a step with a
    // prompt makes resume-through-it unsupported), so this now succeeds.
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "history-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        const secondStep = step({
          id: "second",
        }).do(({ value }: { value: number }) => done({ value: value + 1 }));

        const orchestrationStep = step({
          id: "orchestration",
        }).do((firstOutput: { value: number }) => secondStep(firstOutput));

        return orchestrationStep(input);
      },
    };
    const runDir = await createRunWithEvents([
      event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
      event({ id: "orchestration-started", type: "step.started", stepId: "orchestration" }),
      event({
        id: "orchestration-completed",
        type: "step.completed",
        stepId: "orchestration",
        payload: {},
      }),
      event({ id: "second-started", type: "step.started", stepId: "second" }),
      event({ id: "second-failed", type: "step.failed", stepId: "second" }),
      event({ id: "workflow-failed", type: "workflow.failed" }),
    ]);

    const result = await runWorkflow({ workflow, resume: { runDir } });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.status === "failure" ? result.failure.message : "resume failed");
    }
    expect(result.output).toEqual({ value: 2 });
  });

  it("resumes past a completed prompt/agent step using its recorded output, not config.input", async () => {
    // A prompt step's live-execution paramForNext is the agent's structured output
    // (see run-continuation.ts), not config.input — replaying it must feed the
    // recorded step.completed output back in, and must never re-dispatch the agent.
    let adapterCalls = 0;
    const secondStep = step({
      id: "second",
    }).do(({ value }: { value: number }) => done({ value }));

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "history-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      agents: { assistant: { size: "tiny" } },
      start(input) {
        return step({
          id: "first",
        })
          .prompt(() => "produce a value", {
            output: { value: "number" },
            agent: "assistant",
            adapter: async (request) => {
              adapterCalls += 1;
              await request.tools[0]?.call({ value: 0 });
            },
          })
          .do((output: { value: number }) => secondStep({ value: output.value }))(input);
      },
    };

    const runDir = await createRunWithEvents([
      event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
      event({ id: "first-started", type: "step.started", stepId: "first" }),
      event({
        id: "first-completed",
        type: "step.completed",
        stepId: "first",
        payload: { output: { value: 42 } },
      }),
      event({ id: "second-started", type: "step.started", stepId: "second" }),
      event({ id: "second-failed", type: "step.failed", stepId: "second" }),
      event({ id: "workflow-failed", type: "workflow.failed" }),
    ]);

    const replay = await replayToFailedStep({
      workflow,
      events: await readRunEvents(runDir),
      runDir,
    });

    expect(replay.status).toBe("success");
    if (replay.status !== "success") {
      throw new Error(replay.failure.message);
    }
    expect(replay.node.config.id).toBe("second");
    expect(replay.node.config.input).toEqual({ value: 42 });
    expect(adapterCalls).toBe(0);
  });

  it("allows the anchor (failed) step itself to be a prompt/agent step", async () => {
    // A failed prompt step gets fed straight back into a live runContinuation() by the
    // caller (run-workflow.ts), which dispatches it fresh — there's no replay hazard in
    // retrying a thrown agent step, so this must succeed rather than being rejected.
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "history-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      agents: { assistant: { size: "tiny" } },
      start(input) {
        return step({
          id: "first",
        })
          .prompt(() => "produce a value", {
            output: { value: "number" },
            agent: "assistant",
            adapter: async (request) => {
              await request.tools[0]?.call({ value: 2 });
            },
          })
          .do((output: { value: number }) => done(output))(input);
      },
    };

    const runDir = await createRunWithEvents([
      event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
      event({ id: "first-started", type: "step.started", stepId: "first" }),
      event({ id: "first-failed", type: "step.failed", stepId: "first" }),
      event({ id: "workflow-failed", type: "workflow.failed" }),
    ]);

    const replay = await replayToFailedStep({
      workflow,
      events: await readRunEvents(runDir),
      runDir,
    });

    expect(replay.status).toBe("success");
    if (replay.status !== "success") {
      throw new Error(replay.failure.message);
    }
    expect(replay.node.config.id).toBe("first");
    expect(replay.node.config.prompt).toBeDefined();
    expect(replay.resumedStepId).toBe("first");
  });

  it("rejects completed runs and workflow mismatch with specific failure codes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "completed-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return step({
          id: "only",
        }).do(({ value }: { value: number }) => done({ value }))(input);
      },
    };

    const completed = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "completed-run",
      cwd,
    });
    expect(completed.status).toBe("success");

    const completedResume = await runWorkflow({ workflow, resume: { runDir: completed.runDir } });
    expect(completedResume.status).toBe("failure");
    if (completedResume.status !== "failure") {
      throw new Error("Expected completed resume to fail.");
    }
    expect(completedResume.failure.code).toBe("resume_target_not_failed");

    const mismatchedWorkflow: Workflow<{ value: number }, { value: number }> = {
      ...workflow,
      id: "different-workflow",
    };
    const mismatchResume = await runWorkflow({
      workflow: mismatchedWorkflow,
      resume: { runDir: completed.runDir },
    });
    expect(mismatchResume.status).toBe("failure");
    if (mismatchResume.status !== "failure") {
      throw new Error("Expected mismatch resume to fail.");
    }
    expect(mismatchResume.failure.code).toBe("resume_workflow_mismatch");
  });
});
