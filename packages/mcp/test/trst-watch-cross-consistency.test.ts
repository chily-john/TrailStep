import { writeFileSync } from "node:fs";
import path from "node:path";

import type { EvidenceExecutionState } from "@trailstep/core";
import { classifyRunState, readRunEvents, toWatchRunState } from "@trailstep/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  type TrstWatchResult,
  type TrstWatchRunState,
  trst_watch,
} from "../src/tools/trst_watch.js";
import {
  appendLines,
  cleanupSandboxes,
  createSandbox,
  deadPid,
  eventLine,
  type TmpSandbox,
  waitLine,
  writeLiveLock,
  writeLiveLockFile,
  writeTrack,
} from "./trst-watch-fixtures.js";

// Cross-consistency guardrail: every fixture is classified twice, independently
// — once by the canonical classifier and once by the real trst_watch tool — and
// the two answers must agree. The watch's public vocabulary has five states, so
// the canonical `unknown` projection is surfaced there as `crashed`; the crash
// code keeps the forensic distinction observable.

const publicWatchStates: readonly TrstWatchRunState[] = [
  "started",
  "in-progress",
  "waiting",
  "terminal",
  "crashed",
];

interface CrossConsistencyRow {
  readonly name: string;
  readonly canonical: EvidenceExecutionState;
  readonly setup: (sandbox: TmpSandbox) => void;
  readonly assertResult?: (result: TrstWatchResult) => void;
}

function emptyTrail(sandbox: TmpSandbox): void {
  writeFileSync(sandbox.eventsFile, "", "utf8");
}

function writeMalformedTrack(sandbox: TmpSandbox): void {
  writeFileSync(path.join(sandbox.runDir, "track.json"), "{not json", "utf8");
}

function writeOversizedTrack(sandbox: TmpSandbox): void {
  writeFileSync(
    path.join(sandbox.runDir, "track.json"),
    JSON.stringify({
      status: "running",
      ownerPid: process.pid,
      padding: "x".repeat(300 * 1024),
    }),
    "utf8",
  );
}

function writeStatuslessTrack(sandbox: TmpSandbox): void {
  writeFileSync(
    path.join(sandbox.runDir, "track.json"),
    JSON.stringify({
      runId: path.basename(sandbox.runDir),
      workflowId: "wf",
    }),
    "utf8",
  );
}

const matrix: readonly CrossConsistencyRow[] = [
  {
    name: "completed run",
    canonical: "completed",
    setup: (sandbox) =>
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("workflow.completed", 2, { output: { ok: true } }),
      ]),
  },
  {
    name: "failed run",
    canonical: "failed",
    setup: (sandbox) =>
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("workflow.failed", 2, {
          failure: { code: "step_failed", message: "boom" },
        }),
      ]),
  },
  {
    name: "cancelled run",
    canonical: "cancelled",
    setup: (sandbox) =>
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("workflow.cancelled", 2, { reason: "operator" }),
      ]),
  },
  {
    name: "cancelled run with cancelRequested and no terminal event",
    canonical: "cancelled",
    setup: (sandbox) =>
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("workflow.cancelRequested", 2, { reason: "operator" }),
      ]),
  },
  {
    name: "run parked on a pending wait",
    canonical: "waiting",
    setup: (sandbox) =>
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        waitLine(2, { waitId: "approval", question: "Approve?" }),
      ]),
    assertResult: (result) => {
      expect(result.waits?.map((wait) => wait.waitId)).toEqual(["approval"]);
    },
  },
  {
    name: "same waitId parked on two parallel branches",
    canonical: "waiting",
    setup: (sandbox) =>
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        waitLine(2, { waitId: "approval", branchId: "a", question: "Branch A?" }),
        waitLine(3, { waitId: "approval", branchId: "b", question: "Branch B?" }),
      ]),
    assertResult: (result) => {
      expect(result.waits?.map((wait) => [wait.waitId, wait.branchId])).toEqual([
        ["approval", "a"],
        ["approval", "b"],
      ]);
    },
  },
  {
    name: "empty trail with a live lock",
    canonical: "active",
    setup: (sandbox) => {
      emptyTrail(sandbox);
      writeLiveLockFile(sandbox);
    },
  },
  {
    name: "empty trail with no lock and a readable running track",
    canonical: "active",
    setup: (sandbox) => {
      emptyTrail(sandbox);
      writeTrack(sandbox);
    },
  },
  {
    name: "live lock with events and a missing track",
    canonical: "active",
    setup: (sandbox) => {
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("step.started", 2, {}, "work"),
      ]);
      writeLiveLockFile(sandbox);
    },
  },
  {
    name: "live lock with events and a malformed track",
    canonical: "active",
    setup: (sandbox) => {
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("step.started", 2, {}, "work"),
      ]);
      writeLiveLockFile(sandbox);
      writeMalformedTrack(sandbox);
    },
  },
  {
    name: "live lock with events and an oversized track",
    canonical: "active",
    setup: (sandbox) => {
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("step.started", 2, {}, "work"),
      ]);
      writeLiveLockFile(sandbox);
      writeOversizedTrack(sandbox);
    },
  },
  {
    name: "no lock with a missing track",
    canonical: "unknown",
    setup: (sandbox) =>
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("step.started", 2, {}, "work"),
      ]),
  },
  {
    name: "no lock with an unreadable track",
    canonical: "unknown",
    setup: (sandbox) => {
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("step.started", 2, {}, "work"),
      ]);
      writeMalformedTrack(sandbox);
    },
  },
  {
    name: "running track with a dead owner",
    canonical: "stale",
    setup: (sandbox) => {
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("step.started", 2, {}, "work"),
      ]);
      writeTrack(sandbox, "running", deadPid);
    },
  },
  {
    name: "waiting-status track with a dead owner",
    canonical: "waiting",
    setup: (sandbox) => {
      appendLines(sandbox, [eventLine("workflow.started", 1)]);
      writeTrack(sandbox, "waiting", deadPid);
    },
  },
  {
    name: "statusless readable track",
    canonical: "unknown",
    setup: (sandbox) => {
      appendLines(sandbox, [eventLine("workflow.started", 1)]);
      writeStatuslessTrack(sandbox);
    },
  },
  {
    name: "event-shaped string inside an agent display payload",
    canonical: "active",
    setup: (sandbox) => {
      appendLines(sandbox, [
        eventLine("workflow.started", 1),
        eventLine("step.started", 2, {}, "work"),
        eventLine("step.display", 3, {
          text: 'agent said: {"type":"workflow.completed","payload":{}}',
        }),
      ]);
      writeLiveLock(sandbox);
    },
  },
];

afterEach(() => {
  cleanupSandboxes();
});

describe("trst_watch cross-consistency with core classifyRunState", () => {
  it.each(matrix)("$name", async (row) => {
    const sandbox = createSandbox();
    row.setup(sandbox);

    const events = await readRunEvents(sandbox.runDir);
    const canonical = await classifyRunState({ runDir: sandbox.runDir, events });
    const projected = toWatchRunState(canonical);
    const expectedWatchState = projected === "unknown" ? "crashed" : projected;

    const result = await trst_watch(
      { runId: path.basename(sandbox.runDir), maxWaitMs: 0 },
      {
        runDir: sandbox.runDir,
        cursorDir: sandbox.cursorDir,
        maxWaitMs: 0,
        pollIntervalMs: 1,
      },
    );

    expect(canonical.state).toBe(row.canonical);
    expect(result.state).toBe(expectedWatchState);
    expect(publicWatchStates).toContain(result.state);

    if (canonical.state === "unknown" || canonical.state === "stale") {
      expect(result.state).toBe("crashed");
      expect(result.crash?.code).toBe(
        canonical.state === "unknown" ? "unknown-run-state" : "no-live-process",
      );
    } else {
      expect(result.crash).toBeUndefined();
    }

    row.assertResult?.(result);
  });
});
