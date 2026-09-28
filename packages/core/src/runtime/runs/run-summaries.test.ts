import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listRunSummaries } from "./run-summaries.js";

describe("listRunSummaries", () => {
  it("summarizes persisted parallel track branches without mutating run artifacts", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-run-summaries-tests",
      `${task.id}-parallel-track`,
    );
    const runDir = join(cwd, ".trailstep", "runs", "parallel-track-run");
    await mkdir(join(runDir, "branches"), { recursive: true });

    await writeFile(
      join(runDir, "track.json"),
      `${JSON.stringify(
        {
          runId: "parallel-track-run",
          status: "failed",
          workers: 2,
          failurePolicy: "fail-fast",
          rootBranchId: "root",
          splitOccurred: true,
          branches: ["branch-1", "branch-2"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(runDir, "branches", "branch-1.json"),
      `${JSON.stringify(
        {
          branchId: "branch-1",
          requestedBranchId: "requested-alpha",
          parentBranchId: "root",
          status: "done",
          workflowId: "child-workflow",
          source: "split root",
          output: { answer: 42 },
          message: "alpha finished",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:03.000Z",
          latestStepIndex: 2,
          latestStepId: "alpha-step",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(runDir, "branches", "branch-2.json"),
      `${JSON.stringify(
        {
          branchId: "branch-2",
          requestedBranchId: "requested-beta",
          parentBranchId: "root",
          status: "failed",
          workflowId: "child-workflow",
          source: "split root",
          output: {},
          failure: { message: "beta exploded" },
          wait: { reason: "needs human", prompt: "Pick a fix" },
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:04.000Z",
          latestStepIndex: 3,
          latestStepId: "beta-step",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(runDir, "events.jsonl"),
      `${[
        eventLine({
          id: "event-1",
          runId: "parallel-track-run",
          workflowId: "parent-workflow",
          type: "workflow.started",
          timestamp: "2026-08-01T00:00:00.000Z",
        }),
        eventLine({
          id: "event-2",
          runId: "parallel-track-run",
          workflowId: "child-workflow",
          stepId: "alpha-step",
          type: "step.display",
          timestamp: "2026-08-01T00:00:03.000Z",
          payload: { branchId: "branch-1", message: "alpha display from event" },
        }),
        eventLine({
          id: "event-3",
          runId: "parallel-track-run",
          workflowId: "child-workflow",
          stepId: "beta-step",
          type: "step.failed",
          timestamp: "2026-08-01T00:00:04.000Z",
          payload: { branchId: "branch-2", failure: { message: "beta exploded from event" } },
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    await expect(listRunSummaries({ cwd })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "parallel-track-run",
          track: expect.objectContaining({
            runId: "parallel-track-run",
            status: "failed",
            branches: [
              expect.objectContaining({
                branchId: "branch-1",
                requestedBranchId: "requested-alpha",
                parentBranchId: "root",
                status: "done",
                workflowId: "child-workflow",
                latestStepIndex: 2,
                latestStepId: "alpha-step",
                latestMessage: "alpha finished",
                output: { answer: 42 },
              }),
              expect.objectContaining({
                branchId: "branch-2",
                requestedBranchId: "requested-beta",
                parentBranchId: "root",
                status: "failed",
                workflowId: "child-workflow",
                latestStepIndex: 3,
                latestStepId: "beta-step",
                latestMessage: "beta exploded from event",
                wait: expect.objectContaining({ reason: "needs human" }),
                failure: expect.objectContaining({ message: "beta exploded" }),
              }),
            ],
          }),
        }),
      ]),
    );
  });

  it("does not classify a retried-successful run as a recent failed run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-run-summaries-tests", task.id);
    const runDir = join(cwd, ".trailstep", "runs", "retried-successful-run");
    await mkdir(runDir, { recursive: true });

    await writeFile(
      join(runDir, "events.jsonl"),
      `${[
        eventLine({
          id: "event-1",
          type: "workflow.started",
          timestamp: "2026-07-31T00:00:00.000Z",
          payload: { input: {} },
        }),
        eventLine({
          id: "failed-event",
          type: "step.failed",
          stepId: "review",
          timestamp: "2026-07-31T00:00:01.000Z",
          payload: { failure: { message: "review failed" } },
        }),
        eventLine({
          id: "event-3",
          type: "workflow.retryStarted",
          timestamp: "2026-07-31T00:00:02.000Z",
          payload: { sourceFailureEventId: "failed-event" },
        }),
        eventLine({
          id: "event-4",
          type: "step.started",
          stepId: "review",
          timestamp: "2026-07-31T00:00:03.000Z",
        }),
        eventLine({
          id: "event-5",
          type: "step.completed",
          stepId: "review",
          timestamp: "2026-07-31T00:00:04.000Z",
        }),
        eventLine({
          id: "event-6",
          type: "workflow.completed",
          timestamp: "2026-07-31T00:00:05.000Z",
          payload: { output: {} },
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId: "retried-successful-run", status: "completed" }),
    ]);
  });
});

function eventLine(options: {
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly stepId?: string;
  readonly payload?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: options.id,
    runId: options.runId ?? "retried-successful-run",
    workflowId: options.workflowId ?? "retry-aware-workflow",
    stepId: options.stepId,
    type: options.type,
    timestamp: options.timestamp,
    schemaVersion: "v0",
    payload: options.payload ?? {},
  });
}
