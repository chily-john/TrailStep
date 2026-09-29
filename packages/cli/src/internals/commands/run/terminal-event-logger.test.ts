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
  it("prints step title and kind when a title is present", () => {
    const lines: string[] = [];
    const logger = createTerminalEventLogger({
      writeLine: (line) => lines.push(line),
      writeError: (line) => lines.push(line),
    });

    logger(
      event({
        type: "step.started",
        stepId: "delegate-turn",
        payload: { stepName: "delegate-turn", title: "Delegate turn", kind: "agent" },
      }),
    );

    expect(lines).toEqual(["→ Delegate turn (agent)"]);
  });

  it("prints step descriptions under the started line", () => {
    const lines: string[] = [];
    const logger = createTerminalEventLogger({
      writeLine: (line) => lines.push(line),
      writeError: (line) => lines.push(line),
    });

    logger(
      event({
        type: "step.started",
        stepId: "delegate-turn",
        payload: {
          stepName: "delegate-turn",
          title: "Delegate turn",
          description: "Runs one continued delegate-agent turn.",
          kind: "agent",
        },
      }),
    );

    expect(lines).toEqual(["→ Delegate turn (agent)", "  Runs one continued delegate-agent turn."]);
  });

  it("falls back to the step id behavior when no title is present", () => {
    const lines: string[] = [];
    const logger = createTerminalEventLogger({
      writeLine: (line) => lines.push(line),
      writeError: (line) => lines.push(line),
    });

    logger(
      event({
        type: "step.started",
        stepId: "delegate-turn",
        payload: { stepName: "delegate-turn", kind: "agent" },
      }),
    );

    expect(lines).toEqual(["→ delegate-turn (agent)"]);
  });

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

  it("prints terminal workflow messages", () => {
    const lines: string[] = [];
    const logger = createTerminalEventLogger({
      writeLine: (line) => lines.push(line),
      writeError: (line) => lines.push(line),
    });

    logger(
      event({ type: "workflow.completed", payload: { output: { ok: true }, message: "Ready" } }),
    );
    logger(
      event({
        type: "workflow.failed",
        payload: {
          failure: { code: "failed", message: "Boom" },
          message: "Needs attention",
        },
      }),
    );

    expect(lines).toEqual([
      "✓ Workflow completed: Ready",
      "✗ Workflow failed: Boom — Needs attention",
    ]);
  });

  it("prints notify progress, warning, and artifact events", () => {
    const lines: string[] = [];
    const logger = createTerminalEventLogger({
      writeLine: (line) => lines.push(line),
      writeError: (line) => lines.push(line),
    });

    logger(event({ type: "step.progress", payload: { message: "Created worktree" } }));
    logger(event({ type: "step.warning", payload: { message: "Validation failed, retrying" } }));
    logger(
      event({
        type: "step.artifact",
        payload: { name: "Research notes", path: "notes.md", mediaType: "text/markdown" },
      }),
    );

    expect(lines).toEqual([
      "• Created worktree",
      "! Validation failed, retrying",
      "↳ Artifact: Research notes — notes.md",
    ]);
  });
});
