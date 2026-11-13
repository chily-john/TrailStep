import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { RunSummary, RunSummaryStatus } from "./run-summaries.js";
import { listRunSummaries, selectRecentFailedRunSummaries } from "./run-summaries.js";

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

  it("uses the track mtime as the timestamp for an event-less terminal run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-run-summaries-tests", task.id);
    const runDir = join(cwd, ".trailstep", "runs", "eventless-terminal-run");
    const trackPath = join(runDir, "track.json");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      trackPath,
      `${JSON.stringify({
        runId: "eventless-terminal-run",
        workflowId: "workflow-a",
        status: "completed",
        branches: [],
      })}\n`,
      "utf8",
    );
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(trackPath, old, old);

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({
        runId: "eventless-terminal-run",
        status: "completed",
        lastTimestamp: "2026-01-01T00:00:00.000Z",
      }),
    ]);
  });

  it("reports an event-less run with a live creation track as active", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-run-summaries-tests", task.id);
    const runDir = join(cwd, ".trailstep", "runs", "fresh-track-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "track.json"),
      `${JSON.stringify({
        runId: "fresh-track-run",
        workflowId: "factory-maintenance",
        status: "running",
        ownerPid: process.pid,
        branches: [],
        splitOccurred: false,
      })}\n`,
      "utf8",
    );

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({
        runId: "fresh-track-run",
        status: "active",
        workflowId: "factory-maintenance",
        track: expect.objectContaining({ status: "running", workflowId: "factory-maintenance" }),
      }),
    ]);
  });

  it("reports an event-less run whose track owner is dead as stale", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-run-summaries-tests", task.id);
    const runDir = join(cwd, ".trailstep", "runs", "dead-owner-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), "", "utf8");
    await writeFile(
      join(runDir, "track.json"),
      `${JSON.stringify({
        runId: "dead-owner-run",
        status: "running",
        ownerPid: 2_147_483_647,
        branches: [],
      })}\n`,
      "utf8",
    );

    const summaries = await listRunSummaries({ cwd });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({ runId: "dead-owner-run", status: "stale", stale: true }),
    );
    expect(summaries[0]?.warning).toContain("no longer alive");
  });

  it("reports an event-less legacy run without a track as unknown", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-run-summaries-tests", task.id);
    await mkdir(join(cwd, ".trailstep", "runs", "legacy-eventless-run"), { recursive: true });

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId: "legacy-eventless-run", status: "unknown" }),
    ]);
  });

  it("reports an event-less run with an unreadable track as unknown", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-run-summaries-tests", task.id);
    const runDir = join(cwd, ".trailstep", "runs", "unreadable-track-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "track.json"), "[]\n", "utf8");

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId: "unreadable-track-run", status: "unknown" }),
    ]);
  });

  it("never lists staging infrastructure as a run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-run-summaries-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    const staleTrack = `${JSON.stringify({
      runId: "phantom",
      status: "running",
      ownerPid: process.pid,
      branches: [],
    })}\n`;
    await mkdir(join(runsRoot, ".staging", "phantom"), { recursive: true });
    await writeFile(join(runsRoot, ".staging", "phantom", "track.json"), staleTrack, "utf8");

    await expect(listRunSummaries({ cwd })).resolves.toEqual([]);
  });

  it("keeps a contested foreign-track directory visible under its own name", async ({ task }) => {
    // A track-less creation can only rename onto an empty target, so a foreign
    // track-bearing directory at the final name is unreachable outside a
    // synthetic fixture. If it exists, it must stay visible: hiding it would
    // orphan a run some other creator believes it owns.
    const cwd = join("node_modules", ".tmp-trailstep-run-summaries-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    const runDir = join(runsRoot, "contested-track-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "track.json"),
      `${JSON.stringify({
        runId: "someone-else",
        status: "running",
        ownerPid: process.pid,
        branches: [],
      })}\n`,
      "utf8",
    );

    const summaries = await listRunSummaries({ cwd });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      runId: "contested-track-run",
      status: "active",
      track: { runId: "someone-else" },
    });
  });
  it("reports a cancelled-then-resumed running run as active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-run-summaries-cycle-"));
    const runId = "cancelled-then-resumed-run";
    const runDir = join(cwd, ".trailstep", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${[
        eventLine({
          id: "event-1",
          runId,
          type: "workflow.started",
          timestamp: "2026-07-31T00:00:00.000Z",
        }),
        eventLine({
          id: "event-2",
          runId,
          type: "workflow.cancelRequested",
          timestamp: "2026-07-31T00:00:01.000Z",
        }),
        eventLine({
          id: "event-3",
          runId,
          type: "workflow.cancelled",
          timestamp: "2026-07-31T00:00:02.000Z",
        }),
        eventLine({
          id: "event-4",
          runId,
          type: "workflow.resumed",
          timestamp: "2026-07-31T00:00:03.000Z",
        }),
        eventLine({
          id: "event-5",
          runId,
          type: "step.started",
          stepId: "work",
          timestamp: "2026-07-31T00:00:04.000Z",
        }),
      ].join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      join(runDir, "track.json"),
      `${JSON.stringify({ runId, status: "running", ownerPid: process.pid, branches: [] })}\n`,
      "utf8",
    );

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({
        runId,
        status: "active",
        lastTimestamp: "2026-07-31T00:00:04.000Z",
      }),
    ]);
  });

  it("reports a failed-then-retried running run as active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-run-summaries-cycle-"));
    const runId = "failed-then-retried-running-run";
    const runDir = join(cwd, ".trailstep", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${[
        eventLine({
          id: "event-1",
          runId,
          type: "workflow.started",
          timestamp: "2026-07-31T00:00:00.000Z",
        }),
        eventLine({
          id: "failed-event",
          runId,
          type: "step.failed",
          stepId: "review",
          timestamp: "2026-07-31T00:00:01.000Z",
          payload: { failure: { message: "review failed" } },
        }),
        eventLine({
          id: "workflow-failed",
          runId,
          type: "workflow.failed",
          timestamp: "2026-07-31T00:00:02.000Z",
          payload: { failure: { message: "review failed" } },
        }),
        eventLine({
          id: "retry-event",
          runId,
          type: "workflow.retryStarted",
          timestamp: "2026-07-31T00:00:03.000Z",
          payload: {
            sourceFailureEventId: "failed-event",
            sourceFailureReplayPosition: 1,
          },
        }),
        eventLine({
          id: "event-5",
          runId,
          type: "step.started",
          stepId: "review",
          timestamp: "2026-07-31T00:00:04.000Z",
        }),
      ].join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      join(runDir, "track.json"),
      `${JSON.stringify({ runId, status: "running", ownerPid: process.pid, branches: [] })}\n`,
      "utf8",
    );

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({
        runId,
        status: "active",
        lastTimestamp: "2026-07-31T00:00:04.000Z",
      }),
    ]);
  });

  it("reports a run resumed and then cancelled again as cancelled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-run-summaries-cycle-"));
    const runId = "resumed-then-cancelled-run";
    const runDir = join(cwd, ".trailstep", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${[
        eventLine({
          id: "event-1",
          runId,
          type: "workflow.started",
          timestamp: "2026-07-31T00:00:00.000Z",
        }),
        eventLine({
          id: "event-2",
          runId,
          type: "workflow.cancelled",
          timestamp: "2026-07-31T00:00:01.000Z",
        }),
        eventLine({
          id: "event-3",
          runId,
          type: "workflow.resumed",
          timestamp: "2026-07-31T00:00:02.000Z",
        }),
        eventLine({
          id: "event-4",
          runId,
          type: "step.started",
          stepId: "work",
          timestamp: "2026-07-31T00:00:03.000Z",
        }),
        eventLine({
          id: "event-5",
          runId,
          type: "workflow.cancelRequested",
          timestamp: "2026-07-31T00:00:04.000Z",
        }),
        eventLine({
          id: "event-6",
          runId,
          type: "workflow.cancelled",
          timestamp: "2026-07-31T00:00:05.000Z",
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId, status: "cancelled" }),
    ]);
  });

  it("reports a resumed run whose earlier cycle was waiting as active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-run-summaries-cycle-"));
    const runId = "resumed-from-wait-run";
    const runDir = join(cwd, ".trailstep", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${[
        eventLine({
          id: "event-1",
          runId,
          type: "workflow.started",
          timestamp: "2026-07-31T00:00:00.000Z",
        }),
        eventLine({
          id: "wait-event",
          runId,
          type: "wait.started",
          stepId: "approval",
          timestamp: "2026-07-31T00:00:01.000Z",
          payload: { waitId: "approve", branchId: "root" },
        }),
        eventLine({
          id: "event-3",
          runId,
          type: "workflow.resumed",
          timestamp: "2026-07-31T00:00:02.000Z",
        }),
        eventLine({
          id: "event-4",
          runId,
          type: "step.started",
          stepId: "work",
          timestamp: "2026-07-31T00:00:03.000Z",
        }),
      ].join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      join(runDir, "track.json"),
      `${JSON.stringify({ runId, status: "running", ownerPid: process.pid, branches: [] })}\n`,
      "utf8",
    );

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId, status: "active" }),
    ]);
  });

  it("reports a dangling step.started with no track or lock as unknown", async () => {
    const runId = "dangling-step-started-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-dangling-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "step.started",
        stepId: "work",
        timestamp: "2026-07-31T00:00:01.000Z",
      }),
    ]);

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId, status: "unknown" }),
    ]);
  });

  it("reports a dangling step.started with a dead running track as stale", async () => {
    const runId = "dangling-step-started-dead-owner-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-dangling-dead-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "step.started",
        stepId: "work",
        timestamp: "2026-07-31T00:00:01.000Z",
      }),
    ]);
    await writeTrackFile(runDir, runId, { status: "running", ownerPid: DEAD_OWNER_PID });

    const summaries = await listRunSummaries({ cwd });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(expect.objectContaining({ runId, status: "stale", stale: true }));
    expect(summaries[0]?.warning).toContain("no longer alive");
  });

  it("falls back to the classifier stale reason when the summary track read fails", async () => {
    const runId = "unreadable-track-summary-stale-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-stale-fallback-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "step.started",
        stepId: "work",
        timestamp: "2026-07-31T00:00:01.000Z",
      }),
    ]);
    await writeTrackFile(runDir, runId, {
      status: "running",
      ownerPid: DEAD_OWNER_PID,
      branches: ["branch-1"],
    });
    await mkdir(join(runDir, "branches"), { recursive: true });
    await writeFile(join(runDir, "branches", "branch-1.json"), "{not json\n", "utf8");

    const summaries = await listRunSummaries({ cwd });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(expect.objectContaining({ runId, status: "stale", stale: true }));
    expect(summaries[0]?.trackWarning).toContain("Could not read track summary");
    expect(summaries[0]?.warning).toContain("no longer alive");
  });

  it("keeps a step.failed run parked on a wait active with the failure as detail", async () => {
    const runId = "step-failed-parked-wait-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-failed-wait-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "step.failed",
        stepId: "review",
        timestamp: "2026-07-31T00:00:01.000Z",
        payload: { failure: { message: "review failed" } },
      }),
      eventLine({
        id: "event-3",
        runId,
        workflowId: "summary-projection-workflow",
        type: "wait.started",
        stepId: "approval",
        timestamp: "2026-07-31T00:00:02.000Z",
        payload: { waitId: "approve" },
      }),
    ]);
    await writeTrackFile(runDir, runId, { status: "waiting", ownerPid: process.pid });

    const summaries = await listRunSummaries({ cwd });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        runId,
        status: "active",
        latestFailure: expect.objectContaining({
          event: expect.objectContaining({ type: "step.failed" }),
        }),
      }),
    );
    expect(summaries[0]?.status).not.toBe("failed");
  });

  it("reports a step.failed run with a dead running track as stale", async () => {
    const runId = "step-failed-dead-owner-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-failed-dead-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "step.failed",
        stepId: "review",
        timestamp: "2026-07-31T00:00:01.000Z",
        payload: { failure: { message: "review failed" } },
      }),
    ]);
    await writeTrackFile(runDir, runId, { status: "running", ownerPid: DEAD_OWNER_PID });

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({
        runId,
        status: "stale",
        stale: true,
        latestFailure: expect.objectContaining({
          event: expect.objectContaining({ type: "step.failed" }),
        }),
      }),
    ]);
  });

  it("reports a step.failed run held by a live lock as active", async () => {
    const runId = "step-failed-live-lock-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-failed-lock-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "step.failed",
        stepId: "review",
        timestamp: "2026-07-31T00:00:01.000Z",
        payload: { failure: { message: "review failed" } },
      }),
    ]);
    await writeTrackFile(runDir, runId, { status: "running", ownerPid: process.pid });
    await writeLiveRunLock(runDir, runId);

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({
        runId,
        status: "active",
        latestFailure: expect.objectContaining({
          event: expect.objectContaining({ type: "step.failed" }),
        }),
      }),
    ]);
  });

  it("reports a terminal workflow.failed run as failed with its failure", async () => {
    const runId = "workflow-failed-terminal-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-workflow-failed-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "step.failed",
        stepId: "review",
        timestamp: "2026-07-31T00:00:01.000Z",
        payload: { failure: { message: "review failed" } },
      }),
      eventLine({
        id: "event-3",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.failed",
        timestamp: "2026-07-31T00:00:02.000Z",
        payload: { failure: { message: "review failed" } },
      }),
    ]);

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({
        runId,
        status: "failed",
        latestFailure: expect.objectContaining({
          workflowId: "summary-projection-workflow",
        }),
      }),
    ]);
  });

  it("keeps a completed event-less track completed even with a live lock", async () => {
    // The track is the only durable completion record for a run that never
    // wrote an event; dropping it would make the run permanently ineligible for
    // storage-lifecycle archive/delete.
    const runId = "eventless-completed-live-lock-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-eventless-lock-", runId);
    await writeTrackFile(runDir, runId, {
      status: "completed",
      workflowId: "summary-projection-workflow",
    });
    await writeLiveRunLock(runDir, runId);

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId, status: "completed" }),
    ]);
  });

  it("reports an event-less run with a live lock and no track as active", async () => {
    const runId = "eventless-live-lock-no-track-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-eventless-live-", runId);
    await writeLiveRunLock(runDir, runId);

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId, status: "active" }),
    ]);
  });

  it("reports a bare cancelRequested with no track or lock as unknown", async () => {
    const runId = "bare-cancel-no-track-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-cancel-missing-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.cancelRequested",
        timestamp: "2026-07-31T00:00:01.000Z",
      }),
    ]);

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId, status: "unknown" }),
    ]);
  });

  it("reports a bare cancelRequested with a live lock as active", async () => {
    const runId = "bare-cancel-live-lock-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-cancel-live-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.cancelRequested",
        timestamp: "2026-07-31T00:00:01.000Z",
      }),
    ]);
    await writeLiveRunLock(runDir, runId);

    await expect(listRunSummaries({ cwd })).resolves.toEqual([
      expect.objectContaining({ runId, status: "active" }),
    ]);
  });

  it("reports a bare cancelRequested with a dead running track as stale", async () => {
    const runId = "bare-cancel-dead-owner-run";
    const { cwd, runDir } = await createRunDir("trailstep-run-summaries-cancel-dead-", runId);
    await writeEventsFile(runDir, [
      eventLine({
        id: "event-1",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.started",
        timestamp: "2026-07-31T00:00:00.000Z",
      }),
      eventLine({
        id: "event-2",
        runId,
        workflowId: "summary-projection-workflow",
        type: "workflow.cancelRequested",
        timestamp: "2026-07-31T00:00:01.000Z",
      }),
    ]);
    await writeTrackFile(runDir, runId, { status: "running", ownerPid: DEAD_OWNER_PID });

    const summaries = await listRunSummaries({ cwd });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(expect.objectContaining({ runId, status: "stale", stale: true }));
  });

  it("selects recent failed runs by recorded failure rather than status", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const summaries: readonly RunSummary[] = [
      failureSummary("stale-failure-run", "stale", {
        lastTimestamp: "2026-07-31T00:00:01.000Z",
        failureTimestamp: "2026-07-31T00:00:01.000Z",
      }),
      failureSummary("active-failure-run", "active", {
        lastTimestamp: "2026-07-31T00:00:02.000Z",
        failureTimestamp: "2026-07-31T00:00:02.000Z",
      }),
      failureSummary("old-failure-run", "failed", {
        lastTimestamp: "2020-01-01T00:00:00.000Z",
        failureTimestamp: "2020-01-01T00:00:00.000Z",
      }),
      {
        runId: "failed-without-failure-run",
        runDir: "/tmp/failed-without-failure-run",
        status: "failed",
        lastTimestamp: "2026-07-31T00:00:00.000Z",
      },
    ];

    expect(
      selectRecentFailedRunSummaries(summaries, { now }).map((summary) => summary.runId),
    ).toEqual(["active-failure-run", "stale-failure-run"]);
  });
});

const DEAD_OWNER_PID = 2_147_483_647;

async function createRunDir(
  prefix: string,
  runId: string,
): Promise<{ readonly cwd: string; readonly runDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const runDir = join(cwd, ".trailstep", "runs", runId);
  await mkdir(runDir, { recursive: true });
  return { cwd, runDir };
}

async function writeEventsFile(runDir: string, lines: readonly string[]): Promise<void> {
  await writeFile(join(runDir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

async function writeTrackFile(
  runDir: string,
  runId: string,
  track: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(runDir, "track.json"),
    `${JSON.stringify({ runId, branches: [], ...track })}\n`,
    "utf8",
  );
}

async function writeLiveRunLock(runDir: string, runId: string): Promise<void> {
  await writeFile(
    join(runDir, "run.lock"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      pid: process.pid,
      startedAt: "2026-07-31T00:00:00.000Z",
      lastHeartbeatAt: "2026-07-31T00:00:00.000Z",
      nonce: "summary-test-nonce",
    })}\n`,
    "utf8",
  );
}

function failureSummary(
  runId: string,
  status: RunSummaryStatus,
  options: { readonly lastTimestamp: string; readonly failureTimestamp: string },
): RunSummary {
  return {
    runId,
    runDir: `/tmp/${runId}`,
    status,
    lastTimestamp: options.lastTimestamp,
    latestFailure: {
      event: {
        id: `failure-${runId}`,
        runId,
        workflowId: "recent-failure-workflow",
        type: "step.failed",
        timestamp: options.failureTimestamp,
        schemaVersion: "v0",
        payload: { failure: { message: "boom" } },
      },
      replayPosition: 1,
      workflowId: "recent-failure-workflow",
    },
  };
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
