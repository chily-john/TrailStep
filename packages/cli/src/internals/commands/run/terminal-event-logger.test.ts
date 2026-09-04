import type { Event } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { createTerminalEventLogger } from "./terminal-event-logger.js";

function event(overrides: Partial<Event>): Event {
  return {
    id: "event-1",
    runId: "run-1",
    workflowId: "workflow-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: {},
    type: "step.display",
    ...overrides,
  };
}

describe("createTerminalEventLogger", () => {
  it("prints display messages with level markers", () => {
    const lines: string[] = [];
    const logger = createTerminalEventLogger({
      writeLine: (line) => lines.push(line),
      writeError: (line) => lines.push(line),
    });

    logger(event({ payload: { message: "Preparing delegate turn", level: "info" } }));
    logger(event({ payload: { message: "Validation failed; retrying", level: "warning" } }));
    logger(event({ payload: { message: "Failed to prepare optional artifact", level: "error" } }));
    logger(event({ payload: { message: "Debug detail", level: "debug" } }));

    expect(lines).toEqual([
      "• Preparing delegate turn",
      "! Validation failed; retrying",
      "! Failed to prepare optional artifact",
      "• Debug detail",
    ]);
  });
});
