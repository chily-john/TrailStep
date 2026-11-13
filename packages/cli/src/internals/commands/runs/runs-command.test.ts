import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listRunSummaries } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

describe("runs command", () => {
  it("prints compact branch status context for parallel track runs", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-runs-command-tests",
      `${task.id}-parallel-human`,
    );
    await writeParallelTrackFixture(cwd);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["runs"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => lines.push(line) },
      }),
    ).resolves.toBe(0);

    const output = lines.join("\n");
    // No terminal event in this fixture: the eventful summary projects the
    // classifier's unknown instead of re-deriving failed from step.failed.
    expect(output).toContain("parallel-track-run [unknown]");
    expect(output).toContain("branch-1 done");
    expect(output).toContain("branch-2 failed");
    expect(output).toContain("beta exploded");
  });

  it("emits structured branch summaries for parallel track runs as json", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-runs-command-tests",
      `${task.id}-parallel-json`,
    );
    await writeParallelTrackFixture(cwd);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["runs", "--json"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => lines.push(line) },
      }),
    ).resolves.toBe(0);

    const summaries = JSON.parse(lines.join("\n")) as unknown;
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "parallel-track-run",
          track: expect.objectContaining({
            runId: "parallel-track-run",
            status: "failed",
            branches: [
              expect.objectContaining({ branchId: "branch-1", status: "done" }),
              expect.objectContaining({
                branchId: "branch-2",
                status: "failed",
                failure: expect.objectContaining({ message: "beta exploded" }),
              }),
            ],
          }),
        }),
      ]),
    );
  });

  it("excludes retried-successful runs from recent failed section", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-runs-command-tests", task.id);
    const runDir = join(cwd, ".trailstep", "runs", "retried-successful-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${[
        eventLine({
          id: "event-1",
          type: "workflow.started",
          timestamp: "2026-07-31T00:00:00.000Z",
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
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    const lines: string[] = [];

    await expect(
      main({
        argv: ["runs"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => lines.push(line) },
      }),
    ).resolves.toBe(0);

    const output = lines.join("\n");
    const recentFailedSection = output.slice(
      output.indexOf("Recent failed runs (last 7 days):"),
      output.indexOf("All runs:"),
    );
    const allRunsSection = output.slice(output.indexOf("All runs:"));

    expect(recentFailedSection).not.toContain("retried-successful-run");
    expect(allRunsSection).toContain("retried-successful-run [completed]");
  });

  it("uses the creation track for event-less runs and hides staging", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-runs-command-tests", `${task.id}-eventless`);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await writeTrackRun(runsRoot, "fresh-track-run", process.pid);
    await writeTrackRun(runsRoot, "dead-owner-run", 2_147_483_647, { emptyEvents: true });
    await mkdir(join(runsRoot, "legacy-eventless-run"), { recursive: true });
    await writeTrackRun(join(runsRoot, ".staging"), "phantom-run", process.pid);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["runs"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => lines.push(line) },
      }),
    ).resolves.toBe(0);

    const output = lines.join("\n");
    const activeSection = output.slice(
      output.indexOf("Active runs:"),
      output.indexOf("Recent failed runs (last 7 days):"),
    );
    const allRunsSection = output.slice(output.indexOf("All runs:"));

    expect(activeSection).toContain("fresh-track-run [active]");
    expect(allRunsSection).toContain("dead-owner-run [stale]");
    expect(allRunsSection).toContain("legacy-eventless-run [unknown]");
    expect(output).toContain("orphaned");
    expect(output).not.toContain("phantom-run");
  });

  it("agrees with core summaries for event-less running and stale tracks", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-runs-command-tests", `${task.id}-agreement`);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await writeTrackRun(runsRoot, "live-track-run", process.pid);
    await writeTrackRun(runsRoot, "dead-track-run", 2_147_483_647);

    const coreStatuses = (await listRunSummaries({ cwd, runsRoot })).map(
      (summary) => `${summary.runId}:${summary.status}`,
    );
    const lines: string[] = [];
    await expect(
      main({
        argv: ["runs", "--json"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => lines.push(line) },
      }),
    ).resolves.toBe(0);
    const cliStatuses = (
      JSON.parse(lines.join("\n")) as readonly { readonly runId: string; readonly status: string }[]
    ).map((summary) => `${summary.runId}:${summary.status}`);

    expect(cliStatuses).toEqual(coreStatuses);
    expect([...coreStatuses].sort()).toEqual(["dead-track-run:stale", "live-track-run:active"]);
  });

  it("lists a run named like the retired legacy staging pattern", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-runs-command-tests", `${task.id}-legacy-name`);
    const runsRoot = join(cwd, ".trailstep", "runs");
    const runName = ".legit-run.tmp-abc123";
    await writeTrackRun(runsRoot, runName, process.pid);
    await writeTrackRun(runsRoot, "created-after-it", process.pid);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["runs"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => lines.push(line) },
      }),
    ).resolves.toBe(0);

    const output = lines.join("\n");
    expect(output).toContain(`${runName} [active]`);
    await expect(stat(join(runsRoot, runName))).resolves.toBeDefined();
  });
});

async function writeTrackRun(
  runsRoot: string,
  runId: string,
  ownerPid: number,
  options: { readonly emptyEvents?: boolean } = {},
): Promise<void> {
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  if (options.emptyEvents === true) {
    await writeFile(join(runDir, "events.jsonl"), "", "utf8");
  }
  await writeFile(
    join(runDir, "track.json"),
    `${JSON.stringify({ runId, status: "running", ownerPid, branches: [] })}\n`,
    "utf8",
  );
}

async function writeParallelTrackFixture(cwd: string): Promise<void> {
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
}

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
