import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Event } from "../../contracts/events/event.types.js";
import {
  findLifecycleTerminalEvent,
  selectCurrentLifecycleCycle,
} from "../events/lifecycle-cycle.js";
import { listRunSummaries } from "../runs/run-summaries.js";
import { classifyRunState, toPublicWatchRunState } from "./classify-run-state.js";
import { CONTRACT_DEAD_PID, contractTimestamp } from "./run-state-contract-fixtures.js";

// Exhaustive agreement across the run-state surfaces. Every combination is
// written as a real run and judged by the canonical classifier and the real
// run-summary projection. The invariants below are literal consequences of the
// contract (operator decision D1/D2), not a re-expression of the implementation.

type TerminalAxis = "none" | "completed" | "failed" | "cancelled";
type ReopenAxis = "no" | "yes";
type TrackAxis = "none" | "waiting" | "running-live" | "running-dead";
type LockAxis = "none" | "live";
type WaitAxis = "none" | "pending";
type CancelAxis = "none" | "requested";

interface Combination {
  readonly terminal: TerminalAxis;
  readonly reopen: ReopenAxis;
  readonly track: TrackAxis;
  readonly lock: LockAxis;
  readonly wait: WaitAxis;
  readonly cancel: CancelAxis;
}

const terminalAxis: readonly TerminalAxis[] = ["none", "completed", "failed", "cancelled"];
const reopenAxis: readonly ReopenAxis[] = ["no", "yes"];
const trackAxis: readonly TrackAxis[] = ["none", "waiting", "running-live", "running-dead"];
const lockAxis: readonly LockAxis[] = ["none", "live"];
const waitAxis: readonly WaitAxis[] = ["none", "pending"];
const cancelAxis: readonly CancelAxis[] = ["none", "requested"];

const terminalEventTypes = {
  completed: "workflow.completed",
  failed: "workflow.failed",
  cancelled: "workflow.cancelled",
} as const;

function buildEvents(combination: Combination, runId: string): Event[] {
  const specs: Array<{ type: Event["type"]; stepId?: string; payload?: Record<string, unknown> }> =
    [{ type: "workflow.started" }];

  // Before a reopen the trail may only hold the earlier cycle's content; here
  // every terminal is placed in the current cycle so invariant 1 is exercised
  // for every terminal value (superseded terminals are covered by the matrix).
  if (combination.reopen === "no" && combination.terminal !== "none") {
    specs.push({ type: terminalEventTypes[combination.terminal], payload: { reason: "contract" } });
  }
  if (combination.reopen === "yes") {
    specs.push({ type: "workflow.resumed", payload: { resumedStepId: "work" } });
  }
  if (combination.wait === "pending") {
    specs.push({
      type: "wait.started",
      stepId: "wait-step",
      payload: { waitId: "approve", branchId: "root" },
    });
  }
  if (combination.cancel === "requested") {
    specs.push({ type: "workflow.cancelRequested", payload: { reason: "operator" } });
  }
  if (combination.reopen === "yes" && combination.terminal !== "none") {
    specs.push({ type: terminalEventTypes[combination.terminal], payload: { reason: "contract" } });
  }

  return specs.map((spec, index) => ({
    id: `${runId}-event-${index}`,
    runId,
    workflowId: `workflow-${runId}`,
    ...(spec.stepId === undefined ? {} : { stepId: spec.stepId }),
    type: spec.type,
    timestamp: contractTimestamp(runId, index),
    schemaVersion: "v0",
    payload: spec.payload ?? {},
  }));
}

function renderTrack(combination: Combination, runId: string): string | undefined {
  if (combination.track === "none") {
    return undefined;
  }
  if (combination.track === "waiting") {
    return JSON.stringify({
      runId,
      workflowId: `workflow-${runId}`,
      status: "waiting",
      branches: [],
    });
  }
  return JSON.stringify({
    runId,
    workflowId: `workflow-${runId}`,
    status: "running",
    ownerPid: combination.track === "running-live" ? process.pid : CONTRACT_DEAD_PID,
    branches: [],
  });
}

function renderLock(combination: Combination, runId: string): string | undefined {
  if (combination.lock === "none") {
    return undefined;
  }
  return JSON.stringify({
    schemaVersion: 1,
    runId,
    pid: process.pid,
    startedAt: contractTimestamp(runId, 0),
    lastHeartbeatAt: contractTimestamp(runId, 0),
    nonce: "run-state-contract-exhaustive",
  });
}

async function writeCombinationRun(
  combination: Combination,
  index: number,
): Promise<{
  readonly cwd: string;
  readonly runsRoot: string;
  readonly runDir: string;
  readonly runId: string;
  readonly events: Event[];
}> {
  const runId = `exhaustive-${index}`;
  const cwd = await mkdtemp(join(tmpdir(), "trailstep-run-state-exhaustive-"));
  const runsRoot = join(cwd, ".trailstep", "runs");
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });

  const events = buildEvents(combination, runId);
  await writeFile(
    join(runDir, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  const track = renderTrack(combination, runId);
  if (track !== undefined) {
    await writeFile(join(runDir, "track.json"), track, "utf8");
  }
  const lock = renderLock(combination, runId);
  if (lock !== undefined) {
    await writeFile(join(runDir, "run.lock"), lock, "utf8");
  }

  return { cwd, runsRoot, runDir, runId, events };
}

describe("run-state contract exhaustive agreement", () => {
  it("agrees across 256 terminal x reopen x track x lock x wait x cancel rows", {
    timeout: 120_000,
  }, async () => {
    let index = 0;

    for (const terminal of terminalAxis) {
      for (const reopen of reopenAxis) {
        for (const track of trackAxis) {
          for (const lock of lockAxis) {
            for (const wait of waitAxis) {
              for (const cancel of cancelAxis) {
                const combination: Combination = { terminal, reopen, track, lock, wait, cancel };
                const label = `[terminal=${terminal},reopen=${reopen},track=${track},lock=${lock},wait=${wait},cancel=${cancel}]`;
                const { cwd, runsRoot, runDir, runId, events } = await writeCombinationRun(
                  combination,
                  index,
                );
                index += 1;

                const classification = await classifyRunState({ runDir, events });
                const watch = toPublicWatchRunState(classification);
                const summary = (await listRunSummaries({ cwd, runsRoot })).find(
                  (entry) => entry.runId === runId,
                );
                expect(summary, `${label} summary exists`).toBeDefined();

                const currentCycle = selectCurrentLifecycleCycle(events);
                const currentTerminal = findLifecycleTerminalEvent(currentCycle);

                if (currentTerminal !== undefined) {
                  expect(summary?.status, `${label} terminal summary`).toBe(currentTerminal.state);
                } else {
                  expect(
                    ["completed", "failed", "cancelled"],
                    `${label} no current terminal must not summarize as terminal`,
                  ).not.toContain(summary?.status);
                }

                if (cancel === "requested" && currentTerminal === undefined) {
                  expect(classification.state, `${label} bare cancel classifier`).not.toBe(
                    "cancelled",
                  );
                  expect(watch, `${label} bare cancel watch`).not.toBe("terminal");
                }

                if (lock === "live") {
                  expect(watch, `${label} live lock watch`).not.toBe("crashed");
                }

                if (currentTerminal === undefined) {
                  const projection =
                    classification.state === "waiting" ? "active" : classification.state;
                  expect(summary?.status, `${label} summary projects classifier`).toBe(projection);
                }
              }
            }
          }
        }
      }
    }

    expect(index).toBe(256);
  });

  it("encodes the eventless terminal-track carve-out literally", async () => {
    const cases = [
      {
        name: "eventless live running track",
        track: JSON.stringify({ status: "running", ownerPid: process.pid, branches: [] }),
        classifier: "active",
        summary: "active",
      },
      {
        name: "eventless completed track",
        track: JSON.stringify({ status: "completed", branches: [] }),
        classifier: "unknown",
        summary: "completed",
      },
    ] as const;

    for (const entry of cases) {
      const cwd = await mkdtemp(join(tmpdir(), "trailstep-run-state-carve-out-"));
      const runsRoot = join(cwd, ".trailstep", "runs");
      const runId = "carve-out";
      const runDir = join(runsRoot, runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "events.jsonl"), "", "utf8");
      await writeFile(join(runDir, "track.json"), entry.track, "utf8");

      const classification = await classifyRunState({ runDir, events: [] });
      expect(classification.state, `${entry.name} classifier`).toBe(entry.classifier);
      const summary = (await listRunSummaries({ cwd, runsRoot })).find(
        (candidate) => candidate.runId === runId,
      );
      expect(summary?.status, `${entry.name} summary`).toBe(entry.summary);
    }
  });
});
