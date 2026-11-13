import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event } from "../../contracts/events/event.types.js";
import type { EvidenceExecutionState } from "../../contracts/evidence/evidence.types.js";

// Test-only fixtures for the authoritative run-state contract matrix. This
// module is imported by test files only; it is not reachable from the package
// entry point, so it never ships.

export const CONTRACT_DEAD_PID = 2_147_483_646;

const CONTRACT_TIMESTAMP_BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

export type ContractResumeStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type ContractCrashCode = "unknown-run-state" | "no-live-process" | null;

export interface ContractEventSpec {
  readonly type: Event["type"];
  readonly stepId?: string;
  readonly payload?: Record<string, unknown>;
}

export interface ContractTrackSpec {
  readonly status?: string;
  readonly owner?: "live" | "dead";
  readonly mode?: "malformed";
}

export interface ContractRow {
  readonly id: string;
  readonly description: string;
  readonly events: readonly ContractEventSpec[];
  readonly track: ContractTrackSpec | null;
  readonly lock: "live" | "dead" | "none";
  /**
   * Whether the matrix row carries a complete event scan. The cross-surface
   * matrix only carries complete scans: the CLI and MCP watch entry points read
   * the whole trail, so they cannot express a truncated scan. The
   * incomplete-scan + cancellation case is covered by
   * `classify-run-state.test.ts` (the `budget-exceeded` diagnostic) instead.
   */
  readonly scanComplete: boolean;
  readonly expect: {
    readonly classifier: EvidenceExecutionState;
    readonly watch: "started" | "in-progress" | "waiting" | "terminal" | "crashed";
    readonly crashCode: ContractCrashCode;
    readonly summary: "active" | "completed" | "failed" | "cancelled" | "stale" | "unknown";
    readonly evidence: EvidenceExecutionState;
    readonly resume: ContractResumeStatus;
    readonly cli: {
      readonly exitCode: number;
      readonly stderrIncludes: readonly string[];
    };
  };
  readonly crashMessageIncludes?: readonly string[];
  readonly note?: string;
}

export interface ContractMatrix {
  readonly version: number;
  readonly rows: readonly ContractRow[];
}

/** Load the one shared matrix. The relative URL keeps it dependency-free. */
export function loadContractMatrix(): ContractMatrix {
  const text = readFileSync(
    new URL("../../../test-fixtures/run-state-contract.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as ContractMatrix;
}

/** Deterministic timestamp derived from the row id and event index, never wall-clock. */
export function contractTimestamp(rowId: string, index: number): string {
  let hash = 0;
  for (const character of rowId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 86_400;
  }
  return new Date(CONTRACT_TIMESTAMP_BASE + (hash + index) * 1000).toISOString();
}

/** Synthesize the full event objects the runtime would have written. */
export function contractEvents(row: ContractRow): Event[] {
  return row.events.map((spec, index) => ({
    id: `${row.id}-event-${index}`,
    runId: row.id,
    workflowId: `workflow-${row.id}`,
    ...(spec.stepId === undefined ? {} : { stepId: spec.stepId }),
    type: spec.type,
    timestamp: contractTimestamp(row.id, index),
    schemaVersion: "v0",
    payload: spec.payload ?? {},
  }));
}

/** Write one matrix row as a real run directory under a temp runs root. */
export async function writeContractRun(row: ContractRow): Promise<{
  readonly cwd: string;
  readonly runsRoot: string;
  readonly runDir: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), `trailstep-run-state-${row.id}-`));
  const runsRoot = join(cwd, ".trailstep", "runs");
  const runDir = join(runsRoot, row.id);
  await mkdir(runDir, { recursive: true });

  const events = contractEvents(row);
  await writeFile(
    join(runDir, "events.jsonl"),
    events.length === 0 ? "" : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  if (row.track !== null) {
    await writeFile(join(runDir, "track.json"), renderTrack(row), "utf8");
  }

  if (row.lock !== "none") {
    await writeFile(
      join(runDir, "run.lock"),
      JSON.stringify({
        schemaVersion: 1,
        runId: row.id,
        pid: row.lock === "live" ? process.pid : CONTRACT_DEAD_PID,
        startedAt: contractTimestamp(row.id, 0),
        lastHeartbeatAt: contractTimestamp(row.id, 0),
        nonce: `run-state-contract-${row.lock}`,
      }),
      "utf8",
    );
  }

  return { cwd, runsRoot, runDir };
}

function renderTrack(row: ContractRow): string {
  const track = row.track;
  if (track === null) {
    throw new Error(`Row ${row.id} has no track`);
  }
  if (track.mode === "malformed") {
    return "{not json";
  }
  return JSON.stringify({
    runId: row.id,
    workflowId: `workflow-${row.id}`,
    status: track.status,
    ...(track.owner === undefined
      ? {}
      : { ownerPid: track.owner === "live" ? process.pid : CONTRACT_DEAD_PID }),
    branches: [],
    splitOccurred: false,
  });
}
