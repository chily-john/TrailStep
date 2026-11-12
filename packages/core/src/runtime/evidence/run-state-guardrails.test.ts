import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { EvidenceExecutionState } from "../../contracts/evidence/evidence.types.js";
import { appendEvent, atomicWriteJson, readRunEvents } from "../artifacts/run-storage.js";
import { createEvent } from "../events/create-run-event.js";
import { initializeRun } from "../run-workflow/initialize-run.js";
import {
  classifyRunState,
  type RunStateClassification,
  toWatchRunState,
  type WatchRunState,
} from "./classify-run-state.js";

// Guardrails for run-state drift. These are intentionally tests-only: the
// classifier and the watch projection are the production seams, and these
// suites fail when either side stops matching the agreed contract.

const workflowId = "run-state-guardrails";

function classification(state: EvidenceExecutionState, eventCount: number): RunStateClassification {
  return {
    state,
    diagnostics: [],
    pendingWaits: [],
    eventCount,
    ownerAlive: false,
  };
}

interface MappingRow {
  readonly eventCount: number;
  readonly expected: WatchRunState;
}

/**
 * The complete evidence-state → watch-state decision table.
 *
 * `satisfies Record<EvidenceExecutionState, ...>` makes adding an evidence
 * state without deciding its watch projection a typecheck failure; the test
 * below also enumerates the keys at runtime so a table that stops covering the
 * declared states fails without relying on the compiler alone.
 */
const mappingTable = {
  active: [
    { eventCount: 0, expected: "started" },
    { eventCount: 2, expected: "in-progress" },
  ],
  waiting: [{ eventCount: 1, expected: "waiting" }],
  completed: [{ eventCount: 2, expected: "terminal" }],
  failed: [{ eventCount: 2, expected: "terminal" }],
  cancelled: [{ eventCount: 2, expected: "terminal" }],
  stale: [{ eventCount: 2, expected: "crashed" }],
  unknown: [{ eventCount: 1, expected: "unknown" }],
} as const satisfies Record<EvidenceExecutionState, readonly MappingRow[]>;

const evidenceStates = [
  "active",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "stale",
  "unknown",
] as const satisfies readonly EvidenceExecutionState[];

const publicOrUnknownStates: readonly WatchRunState[] = [
  "started",
  "in-progress",
  "waiting",
  "terminal",
  "crashed",
  "unknown",
];

async function createRunThroughRealCreationPath(): Promise<{
  readonly runId: string;
  readonly runDir: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "trailstep-run-state-invariant-"));
  const initialized = await initializeRun({
    workflow: {
      id: workflowId,
      start() {
        throw new Error("not used by this guardrail test");
      },
    },
    input: {},
    runName: "invariant-run",
    cwd,
  });
  return { runId: initialized.runId, runDir: initialized.runDir };
}

async function writeLiveLock(runDir: string, runId: string): Promise<void> {
  await writeFile(
    join(runDir, "run.lock"),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      lastHeartbeatAt: new Date(0).toISOString(),
      nonce: "run-state-guardrail-live-lock",
    }),
    "utf8",
  );
}

describe("watch projection mapping exhaustiveness", () => {
  it("decides every evidence execution state in the watch projection table", () => {
    expect(Object.keys(mappingTable).sort()).toEqual([...evidenceStates].sort());

    for (const state of evidenceStates) {
      const rows = mappingTable[state];
      expect(rows.length, `${state} must have at least one mapping row`).toBeGreaterThan(0);

      for (const row of rows) {
        const observed = toWatchRunState(classification(state, row.eventCount));
        expect(observed, `${state} with ${row.eventCount} events`).toBe(row.expected);
        expect(
          publicOrUnknownStates,
          `${state} must project into the public watch vocabulary`,
        ).toContain(observed);
      }
    }
  });
});

describe("new-run classification invariant", () => {
  it("invariant: a run created through the real creation path is never classified unknown at any observable point", async () => {
    const { runId, runDir } = await createRunThroughRealCreationPath();

    // 1. Immediately after createRunDirectory returns: track.json exists and
    //    records a live running owner, but no event has been emitted yet.
    const beforeAnyEvent = await classifyRunState({ runDir, events: [] });
    expect(beforeAnyEvent.state).toBe("active");
    expect(beforeAnyEvent.state).not.toBe("unknown");
    expect(beforeAnyEvent.eventCount).toBe(0);
    expect(toWatchRunState(beforeAnyEvent)).toBe("started");

    // 2. After the first workflow event is appended to the real trail.
    await appendEvent(runDir, createEvent({ runId, workflowId, type: "workflow.started" }));
    const events = await readRunEvents(runDir);
    const afterFirstEvent = await classifyRunState({ runDir, events });
    expect(afterFirstEvent.state).toBe("active");
    expect(afterFirstEvent.state).not.toBe("unknown");
    expect(afterFirstEvent.eventCount).toBe(1);
    expect(toWatchRunState(afterFirstEvent)).toBe("in-progress");

    // 3. With the scheduler's first full track write (the creation track is
    //    replaced, not removed).
    await atomicWriteJson(join(runDir, "track.json"), {
      runId,
      workflowId,
      status: "running",
      ownerPid: process.pid,
      workers: 1,
      failurePolicy: "fail-fast",
      rootBranchId: "root",
      splitOccurred: false,
      branches: ["root"],
    });
    const afterSchedulerTrack = await classifyRunState({ runDir, events });
    expect(afterSchedulerTrack.state).toBe("active");
    expect(afterSchedulerTrack.state).not.toBe("unknown");
    expect(afterSchedulerTrack.trackStatus).toBe("running");
    expect(afterSchedulerTrack.ownerPid).toBe(process.pid);
    expect(toWatchRunState(afterSchedulerTrack)).toBe("in-progress");
  });

  it("converse invariant: a trackless legacy run is unknown only while no live lock holds it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-run-state-legacy-"));
    const runId = "legacy-run";
    const runDir = join(cwd, runId);
    await mkdir(runDir, { recursive: true });
    await appendEvent(runDir, createEvent({ runId, workflowId, type: "workflow.started" }));
    await appendEvent(
      runDir,
      createEvent({ runId, workflowId, type: "step.started", stepId: "work" }),
    );
    const events = await readRunEvents(runDir);

    const trackless = await classifyRunState({ runDir, events });
    expect(trackless.state).toBe("unknown");
    expect(trackless.state).not.toBe("active");
    expect(trackless.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing-source");
    expect(toWatchRunState(trackless)).toBe("unknown");

    // A live lock is direct evidence of execution and outranks absent track
    // metadata: the same legacy directory must not be called unknown.
    await writeLiveLock(runDir, runId);
    const locked = await classifyRunState({ runDir, events });
    expect(locked.state).toBe("active");
    expect(locked.state).not.toBe("unknown");
    expect(toWatchRunState(locked)).toBe("in-progress");
  });
});
