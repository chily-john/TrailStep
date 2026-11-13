import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendEvent } from "../artifacts/run-storage.js";
import { createEvent } from "../events/create-run-event.js";
import { initializeRun } from "./initialize-run.js";

const workflow = {
  id: "initialize-run-workflow",
  start() {
    throw new Error("not used");
  },
};

describe("initializeRun", () => {
  it("creates a run directory for a new run and returns no previous events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-initialize-run-"));

    const initialized = await initializeRun({
      workflow,
      input: {},
      runName: "new-run",
      cwd,
    });

    expect(initialized.runId).toBe("new-run");
    expect(basename(initialized.runDir)).toBe("new-run");
    expect(initialized.previousEvents).toEqual([]);
  });

  it("writes a running track.json with the owner pid before any event exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-initialize-track-"));

    const initialized = await initializeRun({
      workflow,
      input: {},
      runName: "new-track-run",
      cwd,
      scheduler: { workers: 2 },
    });

    const track = JSON.parse(
      await readFile(join(initialized.runDir, "track.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(track).toEqual({
      runId: "new-track-run",
      workflowId: workflow.id,
      status: "running",
      ownerPid: process.pid,
      branches: [],
      splitOccurred: false,
    });
    await expect(readFile(join(initialized.runDir, "events.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["resume", "retry", "continue"] as const)(
    "preserves an existing track.json when %s reuses a run directory",
    async (mode) => {
      const cwd = await mkdtemp(join(tmpdir(), `trailstep-initialize-${mode}-`));
      const created = await initializeRun({
        workflow,
        input: {},
        runName: `existing-${mode}-run`,
        cwd,
      });
      const started = createEvent({
        runId: created.runId,
        workflowId: workflow.id,
        type: "workflow.started",
        payload: { input: {} },
      });
      await appendEvent(created.runDir, started);

      const existingTrack = {
        runId: created.runId,
        workflowId: workflow.id,
        status: "completed",
        workers: 1,
        failurePolicy: "fail-fast",
        rootBranchId: "root",
        splitOccurred: false,
        branches: ["root"],
        ownerPid: 424242,
        lastTimestamp: "2026-01-01T00:00:00.000Z",
      };
      const trackPath = join(created.runDir, "track.json");
      const trackContents = `${JSON.stringify(existingTrack, null, 2)}\n`;
      await writeFile(trackPath, trackContents, "utf8");

      const initialized =
        mode === "resume"
          ? await initializeRun({ workflow, resume: { runDir: created.runDir } })
          : mode === "retry"
            ? await initializeRun({
                workflow,
                retry: { runDir: created.runDir, kind: "manual" },
              })
            : await initializeRun({ workflow, continue: { runDir: created.runDir } });

      expect(initialized.runDir).toBe(created.runDir);
      expect(initialized.previousEvents).toEqual([started]);
      await expect(readFile(trackPath, "utf8")).resolves.toBe(trackContents);
    },
  );

  it("returns the existing run directory and previous events for resume", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-initialize-resume-"));
    const created = await initializeRun({ workflow, input: {}, runName: "resume-run", cwd });
    const started = createEvent({
      runId: created.runId,
      workflowId: workflow.id,
      type: "workflow.started",
      payload: { input: {} },
    });
    await appendEvent(created.runDir, started);

    const initialized = await initializeRun({
      workflow,
      resume: { runDir: created.runDir },
    });

    expect(initialized.runId).toBe(created.runId);
    expect(initialized.runName).toBe(created.runId);
    expect(initialized.runDir).toBe(created.runDir);
    expect(initialized.previousEvents).toEqual([started]);
  });
});
