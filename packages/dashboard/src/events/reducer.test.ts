import type { Event } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { reduceDashboardEvents } from "./reducer";

const laterEvent = {
  id: "event-2",
  runId: "run-a",
  workflowId: "local-dashboard",
  type: "step.completed",
  timestamp: "2026-01-02T03:04:05.000Z",
  schemaVersion: "v0",
  payload: {},
} as const satisfies Event;

const earlierEvent = {
  id: "event-1",
  runId: "run-a",
  workflowId: "local-dashboard",
  type: "step.started",
  stepId: "inspect",
  timestamp: "2026-01-02T03:03:05.000Z",
  schemaVersion: "v0",
  payload: {},
} as const satisfies Event;

describe("dashboard event reducer", () => {
  it("adds event rows in order and de-duplicates by id", () => {
    const state = reduceDashboardEvents(
      { rows: [] },
      { type: "events.received", events: [laterEvent, earlierEvent, laterEvent] },
    );

    expect(state.rows).toEqual([
      {
        id: "event-1",
        timestamp: "2026-01-02T03:03:05.000Z",
        type: "step.started",
        stepId: "inspect",
      },
      {
        id: "event-2",
        timestamp: "2026-01-02T03:04:05.000Z",
        type: "step.completed",
        stepId: undefined,
      },
    ]);
  });
});
