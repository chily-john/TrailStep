import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Event } from "../runtime/run-workflow/run-workflow.types.js";
import {
  deriveWorkflowExportName,
  findLatestPendingWait,
  findPendingWaitsById,
  generateRunName,
  hasEventsFile,
  isPathLike,
  readEventsForRun,
  resolveRunDirectory,
  resolveRunsRoot,
  waitEventBranchId,
} from "./index.js";

async function makeRunDir(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trailstep-core-runs-"));
  const runDir = join(root, name);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "events.jsonl"), "", "utf8");
  return runDir;
}

function waitEvent(
  type: "wait.started" | "wait.satisfied",
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

  it("treats events without a branch as the root branch", () => {
    expect(waitEventBranchId(waitEvent("wait.started", { waitId: "w1" }))).toBe("root");
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
