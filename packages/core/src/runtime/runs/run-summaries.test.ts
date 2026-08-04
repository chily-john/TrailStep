import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listRunSummaries } from "./run-summaries.js";

describe("listRunSummaries", () => {
  it("does not classify a retried-successful run as a recent failed run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-summaries-tests", task.id);
    const runDir = join(cwd, ".stepkit", "runs", "retried-successful-run");
    await mkdir(runDir, { recursive: true });

    await writeFile(
      join(runDir, "events.jsonl"),
      [
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
      ].join("\n") + "\n",
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
  readonly stepId?: string;
  readonly payload?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: options.id,
    runId: "retried-successful-run",
    workflowId: "retry-aware-workflow",
    stepId: options.stepId,
    type: options.type,
    timestamp: options.timestamp,
    schemaVersion: "v0",
    payload: options.payload ?? {},
  });
}
