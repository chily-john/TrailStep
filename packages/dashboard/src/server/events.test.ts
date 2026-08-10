import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readDashboardRunEvents, streamRunEvents } from "./events";

describe("dashboard event helpers", () => {
  it("maps resume_target_not_found to an empty event list", async ({ task }) => {
    const runDir = join(process.cwd(), ".tmp", task.id, ".trailstep", "runs", "missing-events");
    await mkdir(runDir, { recursive: true });

    await expect(readDashboardRunEvents(runDir)).resolves.toEqual([]);
  });

  it("streams project-owned TrailStep SSE event names", async ({ task }) => {
    const runDir = join(process.cwd(), ".tmp", task.id, ".trailstep", "runs", "run-a");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({
        id: "event-1",
        runId: "run-a",
        workflowId: "local-dashboard",
        type: "workflow.started",
        timestamp: "2026-01-02T03:00:00.000Z",
        schemaVersion: "v0",
        payload: {},
      })}\n`,
      "utf8",
    );

    let body = "";
    const close = streamRunEvents({
      runDir,
      pollMs: 10,
      response: {
        write(chunk: string) {
          body += chunk;
          return true;
        },
      } as NodeJS.WritableStream,
    });

    try {
      await vi.waitFor(() => expect(body).toContain("event: trailstep-event\n"));
    } finally {
      close();
    }
  });
});
