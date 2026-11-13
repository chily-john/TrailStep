import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Event } from "../../contracts/events/event.types.js";
import type { EvidenceExecutionState } from "../../contracts/evidence/evidence.types.js";
import type { RunLock } from "../run-lock/run-lock.js";
import { initializeRun } from "../run-workflow/initialize-run.js";
import {
  classifyRunState,
  type TrackStateSignal,
  toPublicWatchRunState,
  toWatchRunState,
} from "./classify-run-state.js";

function event(
  type: Event["type"],
  overrides: Partial<Pick<Event, "id" | "stepId" | "payload">> = {},
): Event {
  return {
    id: overrides.id ?? `evt_${type}`,
    runId: "run-1",
    workflowId: "workflow-1",
    ...(overrides.stepId === undefined ? {} : { stepId: overrides.stepId }),
    type,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: overrides.payload ?? {},
  };
}

async function runDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "trailstep-classify-run-state-"));
}

describe("classifyRunState", () => {
  it("lets a terminal event win and maps each terminal kind", async () => {
    for (const type of ["workflow.completed", "workflow.failed", "workflow.cancelled"] as const) {
      const classification = await classifyRunState({
        runDir: await runDir(),
        events: [event("workflow.started"), event(type)],
        trackSignal: null,
        lock: null,
      });
      expect(classification.state).toBe(
        type === "workflow.completed"
          ? "completed"
          : type === "workflow.failed"
            ? "failed"
            : "cancelled",
      );
      expect(classification.diagnostics).toEqual([]);
      expect(classification.startedEventId).toBe("evt_workflow.started");
    }
  });

  it("derives waiting from a pending wait and never flags a waiting track as stale", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [
        event("workflow.started"),
        event("wait.started", { stepId: "approval", payload: { waitId: "w1" } }),
      ],
      trackSignal: { present: true, readable: true, status: "running", ownerPid: 42 },
      lock: null,
      pidIsAlive: () => false,
    });

    expect(classification.state).toBe("waiting");
    expect(classification.pendingWaits).toHaveLength(1);
    expect(classification.diagnostics).toEqual([]);
    expect(toWatchRunState(classification)).toBe("waiting");
  });

  it("keeps a waiting-status track waiting even with a dead owner", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [event("workflow.started")],
      trackSignal: { present: true, readable: true, status: "waiting", ownerPid: 42 },
      lock: null,
      pidIsAlive: () => false,
    });

    expect(classification.state).toBe("waiting");
    expect(classification.diagnostics).toEqual([]);
  });

  it("maps an orphaned running track to stale + stale-owner", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [event("workflow.started"), event("step.started", { stepId: "work" })],
      trackSignal: { present: true, readable: true, status: "running", ownerPid: 4242 },
      lock: null,
      pidIsAlive: () => false,
    });

    expect(classification.state).toBe("stale");
    expect(classification.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "stale-owner",
    ]);
    expect(toWatchRunState(classification)).toBe("crashed");
    expect(toPublicWatchRunState(classification)).toBe("crashed");
  });

  it("maps missing track + no terminal to unknown, never active", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [event("workflow.started"), event("step.started", { stepId: "work" })],
      trackSignal: null,
      lock: null,
    });

    expect(classification.state).toBe("unknown");
    expect(classification.state).not.toBe("active");
    expect(classification.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "missing-source",
    );
    expect(toWatchRunState(classification)).toBe("unknown");
    expect(toPublicWatchRunState(classification)).toBe("crashed");
  });

  it("classifies a freshly created event-less run as a live starting run, not unknown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-classify-fresh-run-"));
    const initialized = await initializeRun({
      workflow: {
        id: "fresh-run-classification",
        start() {
          throw new Error("not used");
        },
      },
      input: {},
      runName: "fresh-run",
      cwd,
    });

    const classification = await classifyRunState({ runDir: initialized.runDir, events: [] });

    expect(classification.state).toBe("active");
    expect(classification.trackStatus).toBe("running");
    expect(classification.ownerPid).toBe(process.pid);
    expect(classification.workflowId).toBe("fresh-run-classification");
    expect(classification.diagnostics).toEqual([]);
    expect(toWatchRunState(classification)).toBe("started");
  });

  it("maps cancelRequested without a terminal event by state, never to cancelled", async () => {
    const liveLock: RunLock = {
      schemaVersion: 1,
      runId: "run-1",
      pid: 42,
      startedAt: "2026-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      nonce: "nonce",
    };
    const cancel = event("workflow.cancelRequested");
    const started = event("workflow.started");
    const wait = event("wait.started", { stepId: "approval", payload: { waitId: "w1" } });

    const rows: readonly {
      readonly name: string;
      readonly events: readonly Event[];
      readonly trackSignal?: TrackStateSignal | null;
      readonly lock?: RunLock | null;
      readonly pidIsAlive?: (pid: number) => boolean;
      readonly eventsComplete?: boolean;
      readonly state: EvidenceExecutionState;
      readonly diagnosticCodes: readonly string[];
      readonly trapMessage?: boolean;
    }[] = [
      {
        name: "no track and no lock is unknown with the cancellation diagnostic",
        events: [started, cancel],
        trackSignal: null,
        lock: null,
        state: "unknown",
        diagnosticCodes: ["missing-source", "cancellation-pending"],
      },
      {
        name: "a live lock stays active and names the pending cancellation",
        events: [started, cancel],
        trackSignal: null,
        lock: liveLock,
        pidIsAlive: () => true,
        state: "active",
        diagnosticCodes: ["cancellation-pending"],
      },
      {
        name: "a live lock outranks a pending wait, which must not be answerable",
        events: [started, wait, cancel],
        trackSignal: null,
        lock: liveLock,
        pidIsAlive: () => true,
        state: "active",
        diagnosticCodes: ["cancellation-pending"],
      },
      {
        name: "a live track owner stays active",
        events: [started, cancel],
        trackSignal: { present: true, readable: true, status: "running", ownerPid: 42 },
        lock: null,
        pidIsAlive: () => true,
        state: "active",
        diagnosticCodes: ["cancellation-pending"],
      },
      {
        name: "a running track with a dead owner is stale after the state reason",
        events: [started, cancel],
        trackSignal: { present: true, readable: true, status: "running", ownerPid: 4242 },
        lock: null,
        pidIsAlive: () => false,
        state: "stale",
        diagnosticCodes: ["stale-owner", "cancellation-pending"],
      },
      {
        name: "a waiting track with no live owner is an unanswerable cancellation trap",
        events: [started, cancel],
        trackSignal: { present: true, readable: true, status: "waiting", ownerPid: 42 },
        lock: null,
        pidIsAlive: () => false,
        state: "unknown",
        diagnosticCodes: ["cancellation-pending"],
        trapMessage: true,
      },
      {
        name: "a pending wait with no live owner is an unanswerable cancellation trap",
        events: [started, wait, cancel],
        trackSignal: null,
        lock: null,
        state: "unknown",
        diagnosticCodes: ["cancellation-pending"],
        trapMessage: true,
      },
      {
        name: "a terminal cancellation wins with no cancellation diagnostic",
        events: [started, cancel, event("workflow.cancelled")],
        trackSignal: null,
        lock: null,
        state: "cancelled",
        diagnosticCodes: [],
      },
      {
        name: "an incomplete scan keeps budget-exceeded and appends the cancellation",
        events: [started, cancel],
        trackSignal: null,
        lock: null,
        eventsComplete: false,
        state: "unknown",
        diagnosticCodes: ["budget-exceeded", "cancellation-pending"],
      },
      {
        name: "a cancellation in a superseded cycle is ignored",
        events: [started, cancel, event("workflow.resumed"), event("step.started")],
        trackSignal: { present: true, readable: true, status: "running", ownerPid: 42 },
        lock: null,
        pidIsAlive: () => true,
        state: "active",
        diagnosticCodes: [],
      },
    ];

    for (const row of rows) {
      const classification = await classifyRunState({
        runDir: await runDir(),
        events: row.events,
        ...(row.trackSignal === undefined ? {} : { trackSignal: row.trackSignal }),
        ...(row.lock === undefined ? {} : { lock: row.lock }),
        ...(row.pidIsAlive === undefined ? {} : { pidIsAlive: row.pidIsAlive }),
        ...(row.eventsComplete === undefined ? {} : { eventsComplete: row.eventsComplete }),
      });

      expect(classification.state, row.name).toBe(row.state);
      expect(
        classification.diagnostics.map((diagnostic) => diagnostic.code),
        row.name,
      ).toEqual(row.diagnosticCodes);
      if (row.trapMessage === true) {
        expect(classification.diagnostics, row.name).toHaveLength(1);
        expect(classification.diagnostics[0]?.message, row.name).toContain(
          "answering a wait or continuing would discard the request",
        );
        // The classifier is shared by MCP and CLI; its guidance must not name a
        // CLI-only command (MCP has no cancel tool).
        expect(classification.diagnostics[0]?.message, row.name).toContain(
          "Finish the cancellation (cancel) or deliberately discard it (continue).",
        );
        expect(classification.diagnostics[0]?.message, row.name).not.toContain("trailstep");
      }
    }
  });

  it("reopens a cancelled run when workflow.resumed follows the cancel request", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [
        event("workflow.started"),
        event("workflow.cancelRequested"),
        event("workflow.resumed"),
        event("step.started", { stepId: "work" }),
      ],
      trackSignal: { present: true, readable: true, status: "running", ownerPid: 42 },
      lock: null,
      pidIsAlive: () => true,
    });

    expect(classification.state).toBe("active");
    expect(classification.diagnostics).toEqual([]);
    expect(toWatchRunState(classification)).toBe("in-progress");
  });

  it("ignores a cancelled terminal event from a superseded cycle", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [
        event("workflow.started"),
        event("workflow.cancelRequested"),
        event("workflow.cancelled"),
        event("workflow.resumed"),
        event("step.started", { stepId: "work" }),
      ],
      trackSignal: { present: true, readable: true, status: "running", ownerPid: 42 },
      lock: null,
      pidIsAlive: () => true,
    });

    expect(classification.state).toBe("active");
    expect(classification.terminalEvent).toBeUndefined();
  });

  it("keeps a new request after a resume active with the cancellation diagnostic", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [
        event("workflow.started"),
        event("workflow.cancelRequested"),
        event("workflow.resumed"),
        event("step.started", { stepId: "work" }),
        event("workflow.cancelRequested"),
      ],
      trackSignal: { present: true, readable: true, status: "running", ownerPid: 42 },
      lock: null,
      pidIsAlive: () => true,
    });

    expect(classification.state).toBe("active");
    expect(classification.terminalEvent).toBeUndefined();
    expect(classification.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "cancellation-pending",
    ]);
  });

  it("lets a terminal event after a cancel request win", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [
        event("workflow.started"),
        event("workflow.cancelRequested"),
        event("workflow.completed"),
      ],
      trackSignal: null,
      lock: null,
    });

    expect(classification.state).toBe("completed");
    expect(classification.terminalEvent?.type).toBe("workflow.completed");
    expect(classification.diagnostics).toEqual([]);
  });

  it("does not claim active or stale when the bounded scan is incomplete", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [event("workflow.started")],
      trackSignal: { present: true, readable: true, status: "running", ownerPid: 1 },
      lock: null,
      eventsComplete: false,
      pidIsAlive: () => false,
    });

    expect(classification.state).toBe("unknown");
    expect(classification.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "budget-exceeded",
    );
  });

  it("uses a live lock with a readable track as active and maps an empty trail to started", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [],
      trackSignal: { present: true, readable: true, status: "running" },
      lock: {
        schemaVersion: 1,
        runId: "run-1",
        pid: 42,
        startedAt: "2026-01-01T00:00:00.000Z",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        nonce: "nonce",
      },
      pidIsAlive: () => true,
    });

    expect(classification.state).toBe("active");
    expect(toWatchRunState(classification)).toBe("started");
  });

  it("lets a live lock outrank a missing, unreadable, or unusable track", async () => {
    const liveLock = {
      schemaVersion: 1 as const,
      runId: "run-1",
      pid: 42,
      startedAt: "2026-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      nonce: "nonce",
    };
    const trackSignals = [
      null,
      { present: true, readable: false },
      { present: true, readable: true },
    ] as const;

    for (const trackSignal of trackSignals) {
      const classification = await classifyRunState({
        runDir: await runDir(),
        events: [event("workflow.started")],
        trackSignal,
        lock: liveLock,
        pidIsAlive: () => true,
      });

      expect(classification.state).toBe("active");
      expect(classification.diagnostics).toEqual([]);
      expect(toWatchRunState(classification)).toBe("in-progress");
    }
  });

  it("keeps an unreadable track unknown when there is no live lock", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [event("workflow.started")],
      trackSignal: { present: true, readable: false },
      lock: null,
    });

    expect(classification.state).toBe("unknown");
    expect(classification.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "unreadable-source",
    );
  });

  it("keeps a stale running track crashed when there is no live lock", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [event("workflow.started")],
      trackSignal: { present: true, readable: true, status: "running", ownerPid: 42 },
      lock: null,
      pidIsAlive: () => false,
    });

    expect(classification.state).toBe("stale");
    expect(toWatchRunState(classification)).toBe("crashed");
  });

  it("keeps a readable track with no status unknown when there is no live lock", async () => {
    const classification = await classifyRunState({
      runDir: await runDir(),
      events: [event("workflow.started")],
      trackSignal: { present: true, readable: true },
      lock: null,
    });

    expect(classification.state).toBe("unknown");
    expect(classification.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "partial-coverage",
    );
  });
});
