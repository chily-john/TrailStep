import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listEligibleRetryRuns } from "./eligible-retry-runs.js";

describe("eligible retry runs", () => {
  it("ignores staging infrastructure while keeping real failed runs", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-eligible-retry-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await writeFailedRun(runsRoot, "real-failed-run");
    await writeFailedRun(runsRoot, join(".staging", "phantom-run"));

    const eligible = await listEligibleRetryRuns({ cwd, runsRoot });

    expect(eligible.map((run) => run.runId)).toEqual(["real-failed-run"]);
  });
});

async function writeFailedRun(runsRoot: string, runId: string): Promise<void> {
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  const base = {
    runId,
    workflowId: "review-workflow",
    stepId: "review",
    schemaVersion: "v0",
  };
  await writeFile(
    join(runDir, "events.jsonl"),
    `${[
      JSON.stringify({
        ...base,
        id: "event-1",
        type: "workflow.started",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { input: {} },
      }),
      JSON.stringify({
        ...base,
        id: "event-2",
        type: "step.failed",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { failure: { message: "review failed" } },
      }),
    ].join("\n")}\n`,
    "utf8",
  );
}
