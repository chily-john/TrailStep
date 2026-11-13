import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Event } from "@trailstep/core";
import { readRunEvents } from "@trailstep/core";
import { afterEach, describe, expect, it } from "vitest";

import { statusFromEvents } from "../src/tools/trst_resume.js";
import { trst_watch } from "../src/tools/trst_watch.js";
import {
  cleanupSandboxes,
  createSandbox,
  deadPid,
  type TmpSandbox,
  writeLiveLockFile,
  writeTrack,
} from "./trst-watch-fixtures.js";

// The MCP consumer of the authoritative run-state contract matrix. The same
// JSON is read by the core and CLI tests, so a drift in this surface fails
// here with a literal expected cell instead of a self-derived expectation.

interface ContractEventSpec {
  readonly type: Event["type"];
  readonly stepId?: string;
  readonly payload?: Record<string, unknown>;
}

interface ContractTrackSpec {
  readonly status?: string;
  readonly owner?: "live" | "dead";
  readonly mode?: "malformed";
}

interface ContractRow {
  readonly id: string;
  readonly description: string;
  readonly events: readonly ContractEventSpec[];
  readonly track: ContractTrackSpec | null;
  readonly lock: "live" | "dead" | "none";
  readonly scanComplete: boolean;
  readonly expect: {
    readonly classifier: string;
    readonly watch: string;
    readonly crashCode: string | null;
    readonly summary: string;
    readonly evidence: string;
    readonly resume: string;
    readonly cli: { readonly exitCode: number; readonly stderrIncludes: readonly string[] };
  };
  readonly crashMessageIncludes?: readonly string[];
  readonly note?: string;
}

interface ContractMatrix {
  readonly version: number;
  readonly rows: readonly ContractRow[];
}

const matrix = JSON.parse(
  readFileSync(
    new URL("../../core/test-fixtures/run-state-contract.json", import.meta.url),
    "utf8",
  ),
) as ContractMatrix;

afterEach(() => {
  cleanupSandboxes();
});

function contractTimestamp(rowId: string, index: number): string {
  let hash = 0;
  for (const character of rowId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 86_400;
  }
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + (hash + index) * 1000).toISOString();
}

function contractEventLine(row: ContractRow, index: number): string {
  const spec = row.events[index];
  if (spec === undefined) {
    throw new Error(`Row ${row.id} has no event at index ${index}`);
  }
  return JSON.stringify({
    id: `${row.id}-event-${index}`,
    runId: row.id,
    workflowId: `workflow-${row.id}`,
    ...(spec.stepId === undefined ? {} : { stepId: spec.stepId }),
    type: spec.type,
    timestamp: contractTimestamp(row.id, index),
    schemaVersion: "v0",
    payload: spec.payload ?? {},
  });
}

function writeContractRun(row: ContractRow, sandbox: TmpSandbox): void {
  const lines = row.events.map((_, index) => contractEventLine(row, index));
  writeFileSync(sandbox.eventsFile, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");

  if (row.track !== null) {
    if (row.track.mode === "malformed") {
      writeFileSync(path.join(sandbox.runDir, "track.json"), "{not json", "utf8");
    } else if (row.track.status === "running") {
      writeTrack(sandbox, "running", row.track.owner === "dead" ? deadPid : process.pid);
    } else {
      writeFileSync(
        path.join(sandbox.runDir, "track.json"),
        JSON.stringify({
          runId: row.id,
          workflowId: `workflow-${row.id}`,
          status: row.track.status,
          branches: [],
        }),
        "utf8",
      );
    }
  }

  if (row.lock !== "none") {
    if (row.lock === "live") {
      writeLiveLockFile(sandbox);
    } else {
      writeFileSync(
        path.join(sandbox.runDir, "run.lock"),
        JSON.stringify({
          schemaVersion: 1,
          runId: row.id,
          pid: deadPid,
          startedAt: contractTimestamp(row.id, 0),
          lastHeartbeatAt: contractTimestamp(row.id, 0),
          nonce: `run-state-contract-${row.lock}`,
        }),
        "utf8",
      );
    }
  }
}

describe("run-state contract matrix (MCP watch and resume)", () => {
  it.each(matrix.rows)("$id: $description", async (row) => {
    const sandbox = createSandbox(row.id);
    writeContractRun(row, sandbox);

    const result = await trst_watch(
      { runId: row.id, maxWaitMs: 0 },
      { runDir: sandbox.runDir, cursorDir: sandbox.cursorDir },
    );

    expect(result.state, `${row.id} watch state`).toBe(row.expect.watch);
    expect(result.crash?.code ?? null, `${row.id} crash code`).toBe(row.expect.crashCode);
    if (row.expect.crashCode === null) {
      expect(result.crash, `${row.id} has no crash payload`).toBeUndefined();
    }
    for (const fragment of row.crashMessageIncludes ?? []) {
      expect(
        result.crash?.reason.toLowerCase() ?? "",
        `${row.id} crash reason includes "${fragment}"`,
      ).toContain(fragment.toLowerCase());
    }

    const events = await readRunEvents(sandbox.runDir);
    expect(statusFromEvents(events), `${row.id} resume status`).toBe(row.expect.resume);
  });
});
