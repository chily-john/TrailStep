import { describe, expect, it, vi } from "vitest";

import { createEvent } from "./create-run-event.js";

describe("createEvent", () => {
  it("creates unique ids after a simulated process restart", async () => {
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
    expect(first.id).not.toBe(second.id);
  });
});
