import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, type Event, runWorkflow, step, type Workflow } from "../../index.js";
import { readCancellationMarker, writeCancellationMarker } from "../cancellation/cancellation.js";

function event(input: {
  readonly id: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly type: Event["type"];
  readonly payload?: Event["payload"];
}): Event {
  return {
    id: input.id,
    runId: input.runId,
    workflowId: input.workflowId,
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    type: input.type,
    payload: input.payload ?? {},
  };
}

async function writeCancelledRun(options: {
  readonly cwd: string;
  readonly runName: string;
  readonly workflowId: string;
}): Promise<string> {
  const runDir = join(options.cwd, ".trailstep", "runs", options.runName);
  await mkdir(runDir, { recursive: true });
  const events: readonly Event[] = [
    event({
      id: "workflow-started",
      runId: options.runName,
      workflowId: options.workflowId,
      type: "workflow.started",
      payload: { input: {} },
    }),
    event({
      id: "prepare-started",
      runId: options.runName,
      workflowId: options.workflowId,
      stepId: "prepare",
      type: "step.started",
    }),
    event({
      id: "prepare-completed",
      runId: options.runName,
      workflowId: options.workflowId,
      stepId: "prepare",
      type: "step.completed",
    }),
    event({
      id: "review-started",
      runId: options.runName,
      workflowId: options.workflowId,
      stepId: "review",
      type: "step.started",
    }),
    event({
      id: "cancel-requested",
      runId: options.runName,
      workflowId: options.workflowId,
      type: "workflow.cancelRequested",
      payload: { requestedAt: "2026-01-01T00:00:01.000Z", reason: "No longer needed." },
    }),
    event({
      id: "review-cancelled",
      runId: options.runName,
      workflowId: options.workflowId,
      stepId: "review",
      type: "step.cancelled",
      payload: { requestedAt: "2026-01-01T00:00:01.000Z" },
    }),
    event({
      id: "workflow-cancelled",
      runId: options.runName,
      workflowId: options.workflowId,
      type: "workflow.cancelled",
      payload: { requestedAt: "2026-01-01T00:00:01.000Z" },
    }),
  ];
  await writeFile(
    join(runDir, "events.jsonl"),
    `${events.map((persistedEvent) => JSON.stringify(persistedEvent)).join("\n")}\n`,
    "utf8",
  );

  return runDir;
}

function cancelledRunWorkflow(onReview: () => void): Workflow {
  return {
    id: "cancelled-retry-workflow",
    start(input) {
      return step({ id: "prepare" }).do(() =>
        step({
          id: "review",
        }).do(() => {
          onReview();
          return done({ ok: true });
        })({}),
      )(input);
    },
  };
}

describe("runWorkflow retry of a cancelled run", () => {
  it("re-executes the cancelled step and consumes the pending cancellation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-cancelled-retry-"));
    const runName = "cancelled-retry";
    const runDir = await writeCancelledRun({
      cwd,
      runName,
      workflowId: "cancelled-retry-workflow",
    });
    await writeCancellationMarker({
      runDir,
      reason: "No longer needed.",
      source: "test",
    });
    let reviewCalls = 0;
    const workflow = cancelledRunWorkflow(() => {
      reviewCalls += 1;
    });

    const retried = await runWorkflow({
      workflow,
      retry: { runDir, kind: "manual" },
      cwd,
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }

    expect(retried.output).toEqual({ ok: true });
    expect(reviewCalls).toBe(1);
    // The retry consumes the pending cancellation, so no marker is left
    // behind to cancel the retried run again.
    expect(await readCancellationMarker(runDir)).toBeUndefined();
    const types = retried.events.map((event) => event.type);
    expect(types).toContain("workflow.retryStarted");
    expect(types).toContain("workflow.completed");
    const retryStarted = retried.events.find((event) => event.type === "workflow.retryStarted");
    expect(retryStarted?.payload).toMatchObject({
      retryKind: "manual",
      retriedStepId: "review",
      sourceCancellationEventId: "review-cancelled",
    });
  });

  it("reports a clear failure when a cancelled run has no cancelled step to retry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-cancelled-retry-empty-"));
    const runName = "cancelled-retry-empty";
    const runDir = join(cwd, ".trailstep", "runs", runName);
    await mkdir(runDir, { recursive: true });
    const events: readonly Event[] = [
      event({
        id: "workflow-started",
        runId: runName,
        workflowId: "cancelled-retry-workflow",
        type: "workflow.started",
        payload: { input: {} },
      }),
      event({
        id: "workflow-cancelled",
        runId: runName,
        workflowId: "cancelled-retry-workflow",
        type: "workflow.cancelled",
        payload: {},
      }),
    ];
    await writeFile(
      join(runDir, "events.jsonl"),
      `${events.map((persistedEvent) => JSON.stringify(persistedEvent)).join("\n")}\n`,
      "utf8",
    );
    const workflow = cancelledRunWorkflow(() => undefined);

    const retried = await runWorkflow({
      workflow,
      retry: { runDir, kind: "manual" },
      cwd,
    });

    expect(retried.status).toBe("failure");
    if (retried.status !== "failure") {
      throw new Error("Expected the retry of a cancelled run without a cancelled step to fail.");
    }
    expect(retried.failure.code).toBe("retry_target_not_cancelled");
  });
});
