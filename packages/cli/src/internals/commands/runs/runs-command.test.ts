import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

describe("runs command", () => {
  it("excludes retried-successful runs from recent failed section", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-runs-command-tests", task.id);
    const runDir = join(cwd, ".stepkit", "runs", "retried-successful-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${[
        eventLine({
          id: "event-1",
          type: "workflow.started",
          timestamp: "2026-07-31T00:00:00.000Z",
        }),
        eventLine({
          id: "failed-event",
          type: "step.failed",
          stepId: "review",
          timestamp: "2026-07-31T00:00:01.000Z",
          payload: { failure: { message: "review failed" } },
        }),
        eventLine({
          id: "event-3",
          type: "workflow.retryStarted",
          timestamp: "2026-07-31T00:00:02.000Z",
          payload: { sourceFailureEventId: "failed-event" },
        }),
        eventLine({
          id: "event-4",
          type: "step.started",
          stepId: "review",
          timestamp: "2026-07-31T00:00:03.000Z",
        }),
        eventLine({
          id: "event-5",
          type: "step.completed",
          stepId: "review",
          timestamp: "2026-07-31T00:00:04.000Z",
        }),
        eventLine({
          id: "event-6",
          type: "workflow.completed",
          timestamp: "2026-07-31T00:00:05.000Z",
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    const lines: string[] = [];

    await expect(
      main({
        argv: ["runs"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => lines.push(line) },
      }),
    ).resolves.toBe(0);

    const output = lines.join("\n");
    const recentFailedSection = output.slice(
      output.indexOf("Recent failed runs (last 7 days):"),
      output.indexOf("All runs:"),
    );
    const allRunsSection = output.slice(output.indexOf("All runs:"));

    expect(recentFailedSection).not.toContain("retried-successful-run");
    expect(allRunsSection).toContain("retried-successful-run [completed]");
  });
});

function eventLine(options: {
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly stepId?: string;
  readonly payload?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: options.id,
    runId: "retried-successful-run",
    workflowId: "retry-aware-workflow",
    stepId: options.stepId,
    type: options.type,
    timestamp: options.timestamp,
    schemaVersion: "v0",
    payload: options.payload ?? {},
  });
}
