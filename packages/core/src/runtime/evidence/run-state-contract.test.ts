import { describe, expect, it } from "vitest";

import type { EvidenceExecutionState } from "../../contracts/evidence/evidence.types.js";
import { listPendingWaits } from "../../runs/wait-events.js";
import { readRunEvents } from "../artifacts/run-storage.js";
import {
  findLifecycleCycleStartIndex,
  findLifecycleTerminalEvent,
  selectCurrentLifecycleCycle,
} from "../events/lifecycle-cycle.js";
import type { RunSummaryStatus } from "../runs/run-summaries.js";
import { listRunSummaries } from "../runs/run-summaries.js";
import {
  classifyRunState,
  type PublicWatchRunState,
  toPublicWatchRunState,
} from "./classify-run-state.js";
import { inspectRunEvidence } from "./run-evidence-query.js";
import {
  type ContractResumeStatus,
  type ContractRow,
  contractEvents,
  loadContractMatrix,
  writeContractRun,
} from "./run-state-contract-fixtures.js";

// The authoritative run-state matrix. Every expectation is a literal cell in
// packages/core/test-fixtures/run-state-contract.json; the same file is read
// by the MCP and CLI consumer tests. Nothing here derives an expected value
// from the production code under test.

const matrix = loadContractMatrix();

describe("run-state contract matrix (core consumers)", () => {
  it.each(matrix.rows)("$id: $description", async (row) => {
    const { cwd, runsRoot, runDir } = await writeContractRun(row);
    const events = await readRunEvents(runDir);

    const classification = await classifyRunState({
      runDir,
      events,
      eventsComplete: row.scanComplete,
    });
    expect(classification.state, `${row.id} classifier`).toBe(row.expect.classifier);
    expect(toPublicWatchRunState(classification), `${row.id} watch`).toBe(row.expect.watch);

    const summaries = await listRunSummaries({ cwd, runsRoot });
    const summary = summaries.find((entry) => entry.runId === row.id);
    expect(summary?.status, `${row.id} summary`).toBe(row.expect.summary);

    const inspection = await inspectRunEvidence({
      runsRoot,
      project: { kind: "explicit", key: "run-state-contract" },
      runId: row.id,
    });
    expect(inspection.status, `${row.id} evidence status`).toBe("found");
    expect(inspection.evidence?.execution.state, `${row.id} evidence state`).toBe(
      row.expect.evidence,
    );
  });
});

const requiredClassifierStates = [
  "active",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "stale",
  "unknown",
] as const satisfies readonly EvidenceExecutionState[];

const requiredWatchStates = [
  "started",
  "in-progress",
  "waiting",
  "terminal",
  "crashed",
] as const satisfies readonly PublicWatchRunState[];

const requiredSummaryStatuses = [
  "active",
  "completed",
  "failed",
  "cancelled",
  "stale",
  "unknown",
] as const satisfies readonly RunSummaryStatus[];

const requiredResumeStatuses = [
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const satisfies readonly ContractResumeStatus[];

// `completed` is the documented eventless terminal-track carve-out; the other
// five are the track modes the classifier itself distinguishes.
const requiredTrackModes = [
  "none",
  "waiting",
  "running-live",
  "running-dead",
  "malformed",
  "completed",
] as const;

type TrackMode = (typeof requiredTrackModes)[number];

const requiredLockModes = ["none", "live", "dead"] as const;

function trackModeOf(row: ContractRow): TrackMode {
  if (row.track === null) {
    return "none";
  }
  if (row.track.mode === "malformed") {
    return "malformed";
  }
  if (row.track.status === "waiting") {
    return "waiting";
  }
  if (row.track.status === "completed") {
    return "completed";
  }
  if (row.track.status === "running") {
    if (row.track.owner === "live") {
      return "running-live";
    }
    if (row.track.owner === "dead") {
      return "running-dead";
    }
  }
  throw new Error(`Row ${row.id} uses a track mode the contract does not classify`);
}

function lockModeOf(row: ContractRow): "none" | "live" | "dead" {
  return row.lock;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

describe("run-state contract matrix completeness", () => {
  it("covers every evidence execution state", () => {
    expect(uniqueSorted(matrix.rows.map((row) => row.expect.classifier))).toEqual(
      uniqueSorted(requiredClassifierStates),
    );
  });

  it("covers every public watch state", () => {
    expect(uniqueSorted(matrix.rows.map((row) => row.expect.watch))).toEqual(
      uniqueSorted(requiredWatchStates),
    );
  });

  it("covers every non-archived summary status", () => {
    expect(uniqueSorted(matrix.rows.map((row) => row.expect.summary))).toEqual(
      uniqueSorted(requiredSummaryStatuses),
    );
  });

  it("covers every resume status", () => {
    expect(uniqueSorted(matrix.rows.map((row) => row.expect.resume))).toEqual(
      uniqueSorted(requiredResumeStatuses),
    );
  });

  it("covers every track mode and every lock mode", () => {
    expect(uniqueSorted(matrix.rows.map(trackModeOf))).toEqual(uniqueSorted(requiredTrackModes));
    expect(uniqueSorted(matrix.rows.map(lockModeOf))).toEqual(uniqueSorted(requiredLockModes));
  });

  it("covers the lock/track liveness pairs that discriminate the lock branch", () => {
    // A dead lock must be observed with a live track (active) and a dead track
    // (stale); otherwise `lockLive = lock !== null` is indistinguishable from
    // the real pid check. A live lock over a dead track proves the reverse.
    const deadLockTrackModes = uniqueSorted(
      matrix.rows.filter((row) => row.lock === "dead").map(trackModeOf),
    );
    expect(deadLockTrackModes).toContain("running-live");
    expect(deadLockTrackModes).toContain("running-dead");

    const liveLockDeadTracks = matrix.rows.filter(
      (row) =>
        row.lock === "live" &&
        row.track !== null &&
        row.track.status === "running" &&
        row.track.owner === "dead",
    );
    expect(liveLockDeadTracks.length).toBeGreaterThan(0);
  });

  it("covers every cancellation-request case class", () => {
    const cases: Record<string, ContractRow[]> = {
      terminal: [],
      "no-terminal + live lock": [],
      "no-terminal + no lock + no track": [],
      "no-terminal + waiting track + no lock": [],
      "no-terminal + pending wait": [],
      "superseded by a reopen": [],
    };

    for (const row of matrix.rows) {
      const events = contractEvents(row);
      const cycle = selectCurrentLifecycleCycle(events);
      const currentCancel = cycle.some((event) => event.type === "workflow.cancelRequested");
      const currentTerminal = findLifecycleTerminalEvent(cycle) !== undefined;
      const pendingWait = listPendingWaits(cycle).length > 0;
      const reopened = findLifecycleCycleStartIndex(events) > 0;
      const earlierCancel = events
        .slice(0, findLifecycleCycleStartIndex(events))
        .some((event) => event.type === "workflow.cancelRequested");

      if (currentCancel && currentTerminal) {
        cases.terminal?.push(row);
      }
      if (currentCancel && !currentTerminal && row.lock === "live") {
        cases["no-terminal + live lock"]?.push(row);
      }
      if (currentCancel && !currentTerminal && row.lock === "none" && row.track === null) {
        cases["no-terminal + no lock + no track"]?.push(row);
      }
      if (
        currentCancel &&
        !currentTerminal &&
        row.lock === "none" &&
        row.track?.status === "waiting"
      ) {
        cases["no-terminal + waiting track + no lock"]?.push(row);
      }
      if (currentCancel && !currentTerminal && pendingWait) {
        cases["no-terminal + pending wait"]?.push(row);
      }
      if (reopened && earlierCancel && !currentCancel) {
        cases["superseded by a reopen"]?.push(row);
      }
    }

    for (const [name, rows] of Object.entries(cases)) {
      expect(rows.length, `cancel case "${name}" must have a matrix row`).toBeGreaterThan(0);
    }
  });
});
