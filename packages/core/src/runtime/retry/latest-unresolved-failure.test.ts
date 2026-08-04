import { describe, expect, it } from "vitest";

import type { Event } from "../run-workflow/run-workflow.types.js";
import { selectLatestUnresolvedFailure } from "./latest-unresolved-failure.js";

function event(overrides: Partial<Event> & Pick<Event, "type">): Event {
  return {
    id: `${overrides.type}-event`,
    runId: "retry-run",
    workflowId: "review-workflow",
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: {},
    ...overrides,
  };
}

describe("selectLatestUnresolvedFailure", () => {
  it("selects a dangling step.started event as an interrupted unresolved step", () => {
    const target = selectLatestUnresolvedFailure([
      event({ id: "started", type: "workflow.started", payload: { input: { topic: "retry" } } }),
      event({ id: "review-started", type: "step.started", stepId: "review" }),
    ]);

    expect(target).not.toBeUndefined();
    expect(target?.event.id).toBe("review-started");
    expect(target?.stepId).toBe("review");
  });

  it("selects the latest unresolved failure by event id and replay position when a step id fails more than once", () => {
    const events: readonly Event[] = [
      event({ id: "started", type: "workflow.started", payload: { input: { topic: "retry" } } }),
      event({ id: "review-started-1", type: "step.started", stepId: "review" }),
      event({ id: "review-failed-1", type: "step.failed", stepId: "review" }),
      event({
        id: "retry-started",
        type: "workflow.retryStarted",
        payload: { sourceFailureEventId: "review-failed-1", sourceFailureReplayPosition: 2 },
      }),
      event({ id: "review-started-2", type: "step.started", stepId: "review" }),
      event({ id: "review-failed-2", type: "step.failed", stepId: "review" }),
      event({ id: "workflow-failed", type: "workflow.failed" }),
    ];

    const target = selectLatestUnresolvedFailure(events);

    expect(target).not.toBeUndefined();
    expect(target?.event.id).toBe("review-failed-2");
    expect(target?.sourceFailureEventId).toBe("review-failed-2");
    expect(target?.replayPosition).toBe(5);
    expect(target?.stepId).toBe("review");
  });

  it("returns no target after workflow.completed", () => {
    const target = selectLatestUnresolvedFailure([
      event({ id: "started", type: "workflow.started", payload: { input: { topic: "retry" } } }),
      event({ id: "review-failed", type: "step.failed", stepId: "review" }),
      event({ id: "workflow-completed", type: "workflow.completed" }),
    ]);

    expect(target).toBeUndefined();
  });

  it("does not select a step.started event closed by a later step terminal event", () => {
    const target = selectLatestUnresolvedFailure([
      event({ id: "started", type: "workflow.started", payload: { input: { topic: "retry" } } }),
      event({ id: "review-started", type: "step.started", stepId: "review" }),
      event({ id: "review-completed", type: "step.completed", stepId: "review" }),
      event({ id: "workflow-completed", type: "workflow.completed" }),
    ]);

    expect(target).toBeUndefined();
  });

  it("does not classify a step.started event closed by workflow.failed as dangling", () => {
    const target = selectLatestUnresolvedFailure([
      event({ id: "started", type: "workflow.started", payload: { input: { topic: "retry" } } }),
      event({ id: "review-started", type: "step.started", stepId: "review" }),
      event({ id: "workflow-failed", type: "workflow.failed" }),
    ]);

    expect(target).toMatchObject({
      event: expect.objectContaining({ id: "workflow-failed" }),
      stepId: undefined,
    });
  });

  it("ignores failures already consumed by workflow.retryStarted", () => {
    const target = selectLatestUnresolvedFailure([
      event({ id: "started", type: "workflow.started", payload: { input: { topic: "retry" } } }),
      event({ id: "review-failed", type: "step.failed", stepId: "review" }),
      event({
        id: "retry-started",
        type: "workflow.retryStarted",
        payload: { sourceFailureEventId: "review-failed", sourceFailureReplayPosition: 1 },
      }),
    ]);

    expect(target).toBeUndefined();
  });

  it("selects workflow.failed when it is the latest unresolved terminal failure", () => {
    const target = selectLatestUnresolvedFailure([
      event({ id: "started", type: "workflow.started", payload: { input: { topic: "retry" } } }),
      event({ id: "review-failed", type: "step.failed", stepId: "review" }),
      event({
        id: "retry-started",
        type: "workflow.retryStarted",
        payload: { sourceFailureEventId: "review-failed", sourceFailureReplayPosition: 1 },
      }),
      event({ id: "workflow-failed", type: "workflow.failed" }),
    ]);

    expect(target).toMatchObject({
      event: expect.objectContaining({ id: "workflow-failed" }),
      replayPosition: 3,
      sourceFailureEventId: "workflow-failed",
      stepId: undefined,
    });
  });

  it("reads workflow.started payload.input for retry replay", () => {
    const target = selectLatestUnresolvedFailure([
      event({ id: "started", type: "workflow.started", payload: { input: { topic: "retry" } } }),
      event({ id: "workflow-failed", type: "workflow.failed" }),
    ]);

    expect(target).toMatchObject({
      workflowId: "review-workflow",
      replayPosition: 1,
      workflowInput: { topic: "retry" },
    });
  });

  it("distinguishes duplicate or missing old event ids by replay position", () => {
    const missingIdFailure = event({
      id: undefined as unknown as string,
      type: "step.failed",
      stepId: "review",
    });
    const target = selectLatestUnresolvedFailure([
      event({ id: "started", type: "workflow.started", payload: { input: { topic: "retry" } } }),
      event({ id: "duplicate-failure", type: "step.failed", stepId: "review" }),
      event({ id: "duplicate-failure", type: "step.failed", stepId: "review" }),
      event({
        id: "retry-started",
        type: "workflow.retryStarted",
        payload: { sourceFailureEventId: "duplicate-failure", sourceFailureReplayPosition: 2 },
      }),
      missingIdFailure,
    ]);

    expect(target?.event).toBe(missingIdFailure);
    expect(target?.sourceFailureEventId).toBeUndefined();
    expect(target?.replayPosition).toBe(4);
  });
});
