import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Event } from "../runtime/run-workflow/run-workflow.types.js";
import { deriveWorkflowExportName, generateRunName } from "./generate-run-name.js";
import {
  hasEventsFile,
  isPathLike,
  readEventsForRun,
  resolveRunDirectory,
  resolveRunsRoot,
} from "./run-directory.js";
import {
  findLatestPendingWait,
  findPendingWaitsById,
  listPendingWaits,
  listWaitCancellationAmbiguities,
  waitEventBranchId,
} from "./wait-events.js";

async function makeRunDir(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trailstep-core-runs-"));
  const runDir = join(root, name);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "events.jsonl"), "", "utf8");
  return runDir;
}

function waitEvent(
  type: "wait.started" | "wait.satisfied" | "wait.failed",
  options: {
    readonly waitId: string;
    readonly branchId?: string;
    readonly stepId?: string;
    readonly answerFile?: string;
  },
): Event {
  return {
    id: `${type}-${options.waitId}-${options.branchId ?? "root"}`,
    runId: "run-1",
    workflowId: "workflow-1",
    stepId: options.stepId ?? "step-1",
    timestamp: "2026-01-02T03:04:05.678Z",
    schemaVersion: "v0",
    type,
    payload: {
      waitId: options.waitId,
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      ...(options.answerFile === undefined
        ? {}
        : { artifactPaths: { answerFile: options.answerFile } }),
    },
  };
}

function stepCancelledEvent(options: {
  readonly stepId: string;
  readonly branchId?: string;
}): Event {
  return {
    id: `step.cancelled-${options.stepId}-${options.branchId ?? "unscoped"}`,
    runId: "run-1",
    workflowId: "workflow-1",
    stepId: options.stepId,
    timestamp: "2026-01-02T03:04:05.678Z",
    schemaVersion: "v0",
    type: "step.cancelled",
    payload: {
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      reason: "cancelled in test",
    },
  };
}

describe("runs root resolution", () => {
  it("defaults to <cwd>/.trailstep/runs", () => {
    expect(resolveRunsRoot({ cwd: "/tmp/project" })).toBe(
      join("/tmp/project", ".trailstep", "runs"),
    );
  });

  it("resolves the TRAILSTEP_RUNS_ROOT override against the cwd", () => {
    expect(
      resolveRunsRoot({ cwd: "/tmp/project", env: { TRAILSTEP_RUNS_ROOT: "custom/runs" } }),
    ).toBe(resolve("/tmp/project", "custom", "runs"));
  });

  it("anchors exactly on the supplied project root", () => {
    const projectRoot = join(tmpdir(), "trailstep-runs-root-pinned");

    expect(resolveRunsRoot({ cwd: projectRoot, env: {} })).toBe(
      join(projectRoot, ".trailstep", "runs"),
    );
  });

  it("does not walk the filesystem looking for a project root", async () => {
    // Root discovery is the caller's job (CLI `resolveProjectRoot`): core must keep anchoring on
    // the directory it is given, even when an ancestor carries a `.trailstep` directory.
    const projectRoot = await mkdtemp(join(tmpdir(), "trailstep-runs-no-walk-"));
    const invocationDir = join(projectRoot, "packages", "sub");
    await mkdir(join(projectRoot, ".trailstep", "runs"), { recursive: true });
    await mkdir(invocationDir, { recursive: true });

    expect(resolveRunsRoot({ cwd: invocationDir, env: {} })).toBe(
      join(invocationDir, ".trailstep", "runs"),
    );
  });
});

describe("run directory resolution", () => {
  it("detects path-like values", () => {
    expect(isPathLike("./run")).toBe(true);
    expect(isPathLike("../run")).toBe(true);
    expect(isPathLike("nested/run")).toBe(true);
    expect(isPathLike("plain-run")).toBe(false);
  });

  it("resolves a named run under the runs root", async () => {
    const root = await mkdtemp(join(tmpdir(), "trailstep-core-runs-root-"));
    const runDir = join(root, ".trailstep", "runs", "demo-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), "", "utf8");

    const resolved = await resolveRunDirectory("demo-run", { cwd: root });
    expect(resolved.runDir).toBe(runDir);
    expect(resolved.displayName).toBe("demo-run");
    expect(await hasEventsFile(resolved.runDir)).toBe(true);
  });

  it("prefers a direct run directory path that carries events", async () => {
    const runDir = await makeRunDir("direct-run");
    const resolved = await resolveRunDirectory(runDir, { cwd: process.cwd() });
    expect(resolved.runDir).toBe(runDir);
  });

  it("invokes the not-found hook before falling back", async () => {
    const root = await mkdtemp(join(tmpdir(), "trailstep-core-runs-missing-"));
    const seen: string[] = [];
    await resolveRunDirectory(
      "missing-run",
      { cwd: root },
      {
        onRunNotFound: ({ runNameOrRunDir }) => {
          seen.push(runNameOrRunDir);
        },
      },
    );
    expect(seen).toEqual(["missing-run"]);
  });

  it("refuses to resolve reserved bare run names with a typed failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "trailstep-core-runs-reserved-"));
    await mkdir(join(root, ".trailstep", "runs", ".staging"), { recursive: true });

    for (const runName of [".STAGING", ".staging.", ".Archive ", ".archive."]) {
      await expect(resolveRunDirectory(runName, { cwd: root })).rejects.toMatchObject({
        failure: { code: "run_name_reserved" },
      });
    }
  });

  it("refuses mutating resolution of a reserved entry or anything inside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "trailstep-core-runs-reserved-path-"));
    const runsRoot = join(root, ".trailstep", "runs");
    const archiveDir = join(runsRoot, ".archive");
    const archivedChild = join(archiveDir, "payload-run");
    const archivedNested = join(archivedChild, "steps", "0001-review");
    await mkdir(archivedNested, { recursive: true });
    await writeFile(join(archiveDir, "events.jsonl"), "", "utf8");
    await writeFile(join(archivedChild, "events.jsonl"), "", "utf8");
    await writeFile(join(archivedNested, "events.jsonl"), "", "utf8");

    for (const runDir of [
      archiveDir,
      archivedChild,
      archivedNested,
      join(runsRoot, ".staging"),
      join(runsRoot, ".staging", "child", "nested"),
    ]) {
      await mkdir(runDir, { recursive: true });
      await expect(resolveRunDirectory(runDir, { cwd: root })).rejects.toMatchObject({
        failure: { code: "run_name_reserved" },
      });
    }
  });

  it("still resolves a reserved path for read-only inspection when explicitly allowed", async () => {
    const root = await mkdtemp(join(tmpdir(), "trailstep-core-runs-reserved-readonly-"));
    const archiveDir = join(root, ".trailstep", "runs", ".archive");
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(archiveDir, "events.jsonl"), "", "utf8");

    await expect(
      resolveRunDirectory(archiveDir, { cwd: root }, { access: "inspect" }),
    ).resolves.toMatchObject({ runDir: archiveDir });
  });

  it("reads the events of a run directory", async () => {
    const runDir = await makeRunDir("events-run");
    expect(await readEventsForRun(runDir)).toEqual([]);
  });
});

describe("wait event helpers", () => {
  it("finds every pending wait with the given id", () => {
    const events = [
      waitEvent("wait.started", { waitId: "w1", branchId: "a", answerFile: "answers/a.json" }),
      waitEvent("wait.started", { waitId: "w1", branchId: "b", answerFile: "answers/b.json" }),
      waitEvent("wait.satisfied", { waitId: "w1", branchId: "b", answerFile: "answers/b.json" }),
    ];

    const pending = findPendingWaitsById(events, "w1");
    expect(pending).toHaveLength(1);
    expect(waitEventBranchId(pending[0] as Event)).toBe("a");
  });

  it("finds the latest pending wait", () => {
    const events = [
      waitEvent("wait.started", { waitId: "w1", answerFile: "answers/a.json" }),
      waitEvent("wait.started", { waitId: "w2", answerFile: "answers/b.json" }),
    ];
    expect(findLatestPendingWait(events)?.payload.waitId).toBe("w2");
  });

  it("finds the latest pending wait scoped to a branch", () => {
    const events = [
      waitEvent("wait.started", {
        waitId: "approval",
        branchId: "a",
        answerFile: "answers/a.json",
      }),
      waitEvent("wait.started", {
        waitId: "approval",
        branchId: "b",
        answerFile: "answers/b.json",
      }),
      waitEvent("wait.satisfied", {
        waitId: "approval",
        branchId: "b",
        answerFile: "answers/b.json",
      }),
    ];

    expect(findLatestPendingWait(events, "a")?.payload.branchId).toBe("a");
    expect(findLatestPendingWait(events, "b")).toBeUndefined();
  });

  it("treats events without a branch as the root branch", () => {
    expect(waitEventBranchId(waitEvent("wait.started", { waitId: "w1" }))).toBe("root");
  });

  it("lists a single pending wait", () => {
    const wait = waitEvent("wait.started", { waitId: "w1", answerFile: "answers/a.json" });

    expect(listPendingWaits([wait])).toEqual([wait]);
  });

  it("drops a wait resolved by wait.satisfied", () => {
    const started = waitEvent("wait.started", { waitId: "w1", answerFile: "answers/a.json" });
    const satisfied = waitEvent("wait.satisfied", { waitId: "w1", answerFile: "answers/a.json" });

    expect(listPendingWaits([started, satisfied])).toEqual([]);
  });

  it("drops a wait resolved by wait.failed", () => {
    const started = waitEvent("wait.started", { waitId: "w1", answerFile: "answers/a.json" });
    const failed = waitEvent("wait.failed", { waitId: "w1", answerFile: "answers/a.json" });

    expect(listPendingWaits([started, failed])).toEqual([]);
  });

  it("keeps two same-waitId waits on different branches distinct", () => {
    const branchA = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });
    const branchB = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "b",
      answerFile: "answers/b.json",
    });

    expect(listPendingWaits([branchA, branchB])).toEqual([branchA, branchB]);
  });

  it("returns only the later wait when an earlier same-id wait was already resolved", () => {
    const first = waitEvent("wait.started", { waitId: "w1", answerFile: "answers/a.json" });
    const satisfied = waitEvent("wait.satisfied", { waitId: "w1", answerFile: "answers/a.json" });
    const second = waitEvent("wait.started", { waitId: "w1", answerFile: "answers/a.json" });

    expect(listPendingWaits([first, satisfied, second])).toEqual([second]);
  });

  it("drops a root wait terminated by a later root step cancellation", () => {
    const started = waitEvent("wait.started", { waitId: "approval", stepId: "ask" });
    const cancelled = stepCancelledEvent({ stepId: "ask" });

    expect(listPendingWaits([started, cancelled])).toEqual([]);
    expect(findPendingWaitsById([started, cancelled], "approval")).toEqual([]);
    expect(findLatestPendingWait([started, cancelled])).toBeUndefined();
  });

  it("treats an explicit root cancellation as matching an implicit root wait", () => {
    const started = waitEvent("wait.started", { waitId: "approval", stepId: "ask" });
    const cancelled = stepCancelledEvent({ stepId: "ask", branchId: "root" });

    expect(listPendingWaits([started, cancelled])).toEqual([]);
  });

  it("ignores a step cancellation that precedes every wait", () => {
    const cancelled = stepCancelledEvent({ stepId: "ask" });
    const started = waitEvent("wait.started", { waitId: "approval", stepId: "ask" });

    expect(listPendingWaits([cancelled])).toEqual([]);
    expect(listPendingWaits([cancelled, started])).toEqual([started]);
  });

  it("keeps waits for other steps pending when a step is cancelled", () => {
    const askWait = waitEvent("wait.started", { waitId: "approval", stepId: "ask" });
    const reviewWait = waitEvent("wait.started", { waitId: "verdict", stepId: "review" });
    const cancelled = stepCancelledEvent({ stepId: "ask" });

    expect(listPendingWaits([askWait, reviewWait, cancelled])).toEqual([reviewWait]);
  });

  it("resolves only the cancelled branch for the same wait id", () => {
    const branchA = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });
    const branchB = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "b",
      answerFile: "answers/b.json",
    });
    const cancelledA = stepCancelledEvent({ stepId: "step-1", branchId: "a" });

    expect(listPendingWaits([branchA, branchB, cancelledA])).toEqual([branchB]);
    expect(findPendingWaitsById([branchA, branchB, cancelledA], "approval")).toEqual([branchB]);
    expect(findLatestPendingWait([branchA, branchB, cancelledA], "a")).toBeUndefined();
    expect(findLatestPendingWait([branchA, branchB, cancelledA], "b")).toBe(branchB);
  });

  it("keeps a new wait started after a cancellation in the same step and branch", () => {
    const first = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });
    const cancelled = stepCancelledEvent({ stepId: "step-1", branchId: "a" });
    const second = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });

    expect(listPendingWaits([first, cancelled, second])).toEqual([second]);
  });

  it("keeps a new branch wait started after a legacy unscoped cancellation", () => {
    const first = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });
    const legacyCancelled = stepCancelledEvent({ stepId: "step-1" });
    const second = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });

    expect(listPendingWaits([first, legacyCancelled, second])).toEqual([second]);
    // The first wait still cannot be attributed to branch-a, but the genuinely
    // new wait after the cancellation stays pending.
    expect(listWaitCancellationAmbiguities([first, legacyCancelled, second])).toEqual([
      { wait: first, cancellation: legacyCancelled },
    ]);
  });

  it("keeps a satisfied or failed wait resolved after a later cancellation", () => {
    const satisfiedWait = waitEvent("wait.started", {
      waitId: "one",
      answerFile: "answers/one.json",
    });
    const satisfied = waitEvent("wait.satisfied", {
      waitId: "one",
      answerFile: "answers/one.json",
    });
    const failedWait = waitEvent("wait.started", {
      waitId: "two",
      answerFile: "answers/two.json",
    });
    const failed = waitEvent("wait.failed", {
      waitId: "two",
      answerFile: "answers/two.json",
    });
    const cancelled = stepCancelledEvent({ stepId: "step-1" });

    expect(listPendingWaits([satisfiedWait, satisfied, failedWait, failed, cancelled])).toEqual([]);
  });

  it("withholds a branch wait from pending when only a legacy unscoped cancellation exists", () => {
    const branchWait = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });
    const legacyCancelled = stepCancelledEvent({ stepId: "step-1" });

    expect(listPendingWaits([branchWait, legacyCancelled])).toEqual([]);
    expect(findPendingWaitsById([branchWait, legacyCancelled], "approval")).toEqual([]);
    expect(listWaitCancellationAmbiguities([branchWait, legacyCancelled])).toEqual([
      { wait: branchWait, cancellation: legacyCancelled },
    ]);
  });

  it("does not treat an explicit root cancellation as ambiguous for a branch wait", () => {
    const branchWait = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });
    const rootCancelled = stepCancelledEvent({ stepId: "step-1", branchId: "root" });

    expect(listPendingWaits([branchWait, rootCancelled])).toEqual([branchWait]);
    expect(listWaitCancellationAmbiguities([branchWait, rootCancelled])).toEqual([]);
  });

  it("resolves an ambiguous legacy cancellation branch wait once its branch cancels", () => {
    const branchWait = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });
    const legacyCancelled = stepCancelledEvent({ stepId: "step-1" });
    const branchCancelled = stepCancelledEvent({ stepId: "step-1", branchId: "a" });

    expect(listPendingWaits([branchWait, legacyCancelled, branchCancelled])).toEqual([]);
    expect(listWaitCancellationAmbiguities([branchWait, legacyCancelled, branchCancelled])).toEqual(
      [],
    );
  });

  it("drops a branch wait on the crash window before workflow.cancelled", () => {
    const branchWait = waitEvent("wait.started", {
      waitId: "approval",
      branchId: "a",
      answerFile: "answers/a.json",
    });
    const cancelled = stepCancelledEvent({ stepId: "step-1", branchId: "a" });

    // No workflow.cancelled follows: the branch step cancellation alone must
    // make the wait unanswerable in a crash-window trail.
    expect(listPendingWaits([branchWait, cancelled])).toEqual([]);
  });
});

describe("run name generation", () => {
  it("generates the canonical run name", () => {
    expect(
      generateRunName({
        exportName: "review",
        now: () => new Date("2026-01-02T03:04:05.678Z"),
        randomSuffix: () => "aabbccdd",
      }),
    ).toBe("review-20260102-030405-aabbccdd");
  });

  it("derives the export name from raw workflow refs", () => {
    expect(deriveWorkflowExportName("pkg:someWorkflow")).toBe("someWorkflow");
    expect(deriveWorkflowExportName("pkg#bundleWorkflow")).toBe("bundleWorkflow");
    expect(deriveWorkflowExportName("./workflows/review.mjs")).toBe("review");
    expect(deriveWorkflowExportName("registered-workflow")).toBe("registered-workflow");
  });
});
