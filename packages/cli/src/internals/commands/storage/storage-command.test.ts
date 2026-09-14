import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

describe("storage command", () => {
  it("prints usage for bare storage when prompts are unavailable", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-command-tests", task.id);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["storage"],
        cwd,
        prompts: undefined,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => lines.push(line) },
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toContain("Usage: trailstep storage");
  });

  it("honors TRAILSTEP_RUNS_ROOT for status", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-command-tests", task.id);
    const runsRoot = join(cwd, "custom-runs");
    await writeTerminalRun(runsRoot, "custom-root-run", "2026-01-01T00:00:00.000Z");
    const lines: string[] = [];

    await expect(
      main({
        argv: ["storage", "status"],
        cwd,
        env: { TRAILSTEP_RUNS_ROOT: "custom-runs" },
        io: { writeLine: (line) => lines.push(line), writeError: (line) => lines.push(line) },
      }),
    ).resolves.toBe(0);

    expect(lines).toContain(`Runs root: ${resolve(cwd, "custom-runs")}`);
    expect(lines).toContain("Hot runs: 1");
  });
});

async function writeTerminalRun(runsRoot: string, runId: string, timestamp: string): Promise<void> {
  await mkdir(join(runsRoot, runId), { recursive: true });
  await writeFile(
    join(runsRoot, runId, "events.jsonl"),
    `${eventLine({ runId, type: "workflow.started", timestamp })}\n${eventLine({
      runId,
      type: "workflow.completed",
      timestamp,
    })}\n`,
    "utf8",
  );
}

function eventLine(options: {
  readonly runId: string;
  readonly type: string;
  readonly timestamp: string;
}): string {
  return JSON.stringify({
    id: `${options.runId}-${options.type}`,
    runId: options.runId,
    workflowId: "storage-command-workflow",
    type: options.type,
    timestamp: options.timestamp,
    schemaVersion: "v0",
    payload: {},
  });
}
