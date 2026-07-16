import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listRuns } from "./runs";

const workflowCompletedEvent = {
  id: "event-2",
  runId: "run-a",
  workflowId: "local-dashboard",
  type: "workflow.completed",
  timestamp: "2026-01-02T03:04:05.000Z",
  schemaVersion: "v0",
  payload: {},
};

const workflowStartedEvent = {
  id: "event-1",
  runId: "run-a",
  workflowId: "local-dashboard",
  type: "workflow.started",
  timestamp: "2026-01-02T03:00:00.000Z",
  schemaVersion: "v0",
  payload: {},
};

describe("dashboard run listing", () => {
  it("lists local runs with latest status from core readRunEvents", async ({ task }) => {
    const cwd = join(process.cwd(), ".tmp", task.id);
    const runDir = join(cwd, ".stepkit", "runs", "run-a");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(workflowStartedEvent)}\n${JSON.stringify(workflowCompletedEvent)}\n`,
      "utf8",
    );

    await expect(listRuns({ cwd })).resolves.toEqual([
      {
        runId: "run-a",
        path: runDir,
        status: "completed",
        latestTimestamp: "2026-01-02T03:04:05.000Z",
      },
    ]);
  });
});
