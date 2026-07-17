import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, type Event, runWorkflow, step, type Workflow } from "../../../index.js";
import { appendEvent, createRunDirectory } from "../../artifacts/run-storage.js";

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
    outputShape: { value: "number" },
  }).next(({ value }: { value: number }) => done({ value: value + 1 }));

  const firstStep = step({
    id: "first",
    outputShape: { value: "number" },
  }).next(({ value }: { value: number }) => secondStep({ value: value + 1 }));

  return {
    id: "history-workflow",
    inputShape: { value: "number" },
    outputShape: { value: "number" },
    start(input) {
      return firstStep(input);
    },
  };
}

describe("runWorkflow resume", () => {
  it("resumes a failed two-step run by replaying the completed first step from its recorded position", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
    let firstStepRuns = 0;
    let shouldFailSecondStep = true;

    const secondStep = step({
      id: "second",
      outputShape: { value: "number" },
    }).next(({ value }: { value: number }) => {
      if (shouldFailSecondStep) {
        throw new Error("second step unavailable");
      }

      return done({ value: value + 1 });
    });

    const firstStep = step({
      id: "first",
      outputShape: { value: "number" },
    }).next(({ value }: { value: number }) => {
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
    // A no-prompt step's .next(...) is both its computation and its continuation
    // decision fused into one closure — unlike the old separate run()'s plain,
    // serializable output, there is nothing to persist and feed back in its place.
    // Resuming past a completed no-prompt step therefore re-invokes its .next(...)
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
    // always just a no-prompt step, whether its .next(...) does arithmetic or pure
    // branching. Resume treats every no-prompt step identically (only a step with a
    // prompt makes resume-through-it unsupported), so this now succeeds.
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "history-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        const secondStep = step({
          id: "second",
          outputShape: { value: "number" },
        }).next(({ value }: { value: number }) => done({ value: value + 1 }));

        const orchestrationStep = step({
          id: "orchestration",
          outputShape: { value: "number" },
        }).next((firstOutput: { value: number }) => secondStep(firstOutput));

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

  it("rejects completed runs and workflow mismatch with specific failure codes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "completed-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return step({
          id: "only",
          outputShape: { value: "number" },
        }).next(({ value }: { value: number }) => done({ value }))(input);
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
