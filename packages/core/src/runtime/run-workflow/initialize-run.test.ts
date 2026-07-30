import { mkdtemp } from "node:fs/promises";
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-initialize-run-"));

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

  it("returns the existing run directory and previous events for resume", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-initialize-resume-"));
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
