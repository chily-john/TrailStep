import { describe, expect, it, vi } from "vitest";

import { createEvent } from "./create-run-event.js";

describe("createEvent", () => {
  it("does not create an id that can collide with a fresh process-local counter", async () => {
    const existingPersistedId = "evt_1";
    const first = createEvent({
      runId: "run-1",
      workflowId: "workflow-1",
      type: "workflow.started",
    });

    vi.resetModules();
    const { createEvent: createEventAfterRestart } = await import("./create-run-event.js");

    const second = createEventAfterRestart({
      runId: "run-1",
      workflowId: "workflow-1",
      type: "workflow.started",
    });

    expect(first.id).toMatch(/^evt_/);
    expect(second.id).toMatch(/^evt_/);
    expect(second.id).not.toBe(existingPersistedId);
    expect(first.id).not.toBe(second.id);
  });
});
