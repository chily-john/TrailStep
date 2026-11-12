import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listRunSummaries } from "@trailstep/core";
import { describe, expect } from "vitest";

import { listRuns } from "./runs";
import { it } from "./test-fixtures";

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
  it("lists local runs with latest status from core readRunEvents", async ({ cwd }) => {
    const runDir = join(cwd, ".trailstep", "runs", "run-a");
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

  it("does not list reserved infrastructure as a run", async ({ cwd }) => {
    const runDir = join(cwd, ".trailstep", "runs", ".staging", "phantom-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({ ...workflowStartedEvent, runId: runDir })}\n`,
      "utf8",
    );

    await expect(listRuns({ cwd })).resolves.toEqual([]);
  });

  it("lists a run named like the retired legacy staging pattern", async ({ cwd }) => {
    const runName = ".legit-run.tmp-abc123";
    const runDir = join(cwd, ".trailstep", "runs", runName);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({ ...workflowStartedEvent, runId: runName })}\n`,
      "utf8",
    );

    await expect(listRuns({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId: runName, status: "active" }),
    ]);
  });

  it("agrees with core summaries for event-less running and stale tracks", async ({ cwd }) => {
    const runsRoot = join(cwd, ".trailstep", "runs");
    await writeTrackRun(runsRoot, "live-track-run", process.pid);
    await writeTrackRun(runsRoot, "dead-track-run", 2_147_483_647);

    const coreStatuses = (await listRunSummaries({ cwd, runsRoot })).map(
      (summary) => `${summary.runId}:${summary.status}`,
    );
    const dashboardStatuses = (await listRuns({ cwd })).map(
      (summary) => `${summary.runId}:${summary.status}`,
    );

    expect(dashboardStatuses).toEqual(coreStatuses);
    expect([...coreStatuses].sort()).toEqual(["dead-track-run:stale", "live-track-run:active"]);
  });
});

async function writeTrackRun(runsRoot: string, runId: string, ownerPid: number): Promise<void> {
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "track.json"),
    `${JSON.stringify({ runId, status: "running", ownerPid, branches: [] })}\n`,
    "utf8",
  );
}
