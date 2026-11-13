import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

// The CLI consumer of the authoritative run-state contract matrix. The same
// JSON is read by the core and MCP tests; every expectation here is a literal
// cell (exit code plus required stderr fragments), never derived from the
// watch implementation.

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
    new URL("../../../../../core/test-fixtures/run-state-contract.json", import.meta.url),
    "utf8",
  ),
) as ContractMatrix;

const deadPid = 2_147_483_646;

function contractTimestamp(rowId: string, index: number): string {
  let hash = 0;
  for (const character of rowId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 86_400;
  }
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + (hash + index) * 1000).toISOString();
}

function contractEvent(row: ContractRow, index: number): Event {
  const spec = row.events[index];
  if (spec === undefined) {
    throw new Error(`Row ${row.id} has no event at index ${index}`);
  }
  return {
    id: `${row.id}-event-${index}`,
    runId: row.id,
    workflowId: `workflow-${row.id}`,
    ...(spec.stepId === undefined ? {} : { stepId: spec.stepId }),
    type: spec.type,
    timestamp: contractTimestamp(row.id, index),
    schemaVersion: "v0",
    payload: spec.payload ?? {},
  };
}

async function writeContractRun(cwd: string, row: ContractRow): Promise<void> {
  const runDir = join(cwd, ".trailstep", "runs", row.id);
  await mkdir(runDir, { recursive: true });

  const events = row.events.map((_, index) => contractEvent(row, index));
  await writeFile(
    join(runDir, "events.jsonl"),
    events.length === 0 ? "" : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  if (row.track !== null) {
    if (row.track.mode === "malformed") {
      await writeFile(join(runDir, "track.json"), "{not json", "utf8");
    } else {
      await writeFile(
        join(runDir, "track.json"),
        JSON.stringify({
          runId: row.id,
          workflowId: `workflow-${row.id}`,
          status: row.track.status,
          ...(row.track.owner === undefined
            ? {}
            : { ownerPid: row.track.owner === "live" ? process.pid : deadPid }),
          branches: [],
        }),
        "utf8",
      );
    }
  }

  if (row.lock !== "none") {
    await writeFile(
      join(runDir, "run.lock"),
      JSON.stringify({
        schemaVersion: 1,
        runId: row.id,
        pid: row.lock === "live" ? process.pid : deadPid,
        startedAt: contractTimestamp(row.id, 0),
        lastHeartbeatAt: contractTimestamp(row.id, 0),
        nonce: `run-state-contract-${row.lock}`,
      }),
      "utf8",
    );
  }
}

describe("run-state contract matrix (CLI watch)", () => {
  it.each(matrix.rows)("$id: $description", async (row) => {
    const cwd = await mkdtemp(join(tmpdir(), `trailstep-cli-contract-${row.id}-`));
    await writeContractRun(cwd, row);

    const lines: string[] = [];
    const errors: string[] = [];
    const exitCode = await main({
      argv: ["watch", row.id, "--no-follow"],
      cwd,
      io: {
        writeLine: (line) => lines.push(line),
        writeError: (line) => errors.push(line),
      },
    });

    expect(exitCode, `${row.id} exit code`).toBe(row.expect.cli.exitCode);
    if (row.expect.cli.stderrIncludes.length === 0) {
      expect(errors, `${row.id} has silent stderr`).toEqual([]);
      return;
    }
    const stderr = errors.join("\n").toLowerCase();
    for (const fragment of row.expect.cli.stderrIncludes) {
      expect(stderr, `${row.id} stderr includes "${fragment}"`).toContain(fragment);
    }
  });
});
