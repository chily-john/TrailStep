import type { Event } from "@trailstep/core";
import { describe, expect, it } from "vitest";
import { findLatestPendingWait, findPendingWaitById } from "./wait-run-helpers.js";

function waitEvent(options: {
  readonly type: Event["type"];
  readonly stepId?: string;
  readonly waitId?: string;
  readonly branchId?: string;
  readonly answerFile?: string;
}): Event {
  return {
    id: `evt-${options.type}-${options.branchId ?? "root"}-${options.waitId ?? "none"}`,
    runId: "run",
    workflowId: "workflow",
    stepId: options.stepId,
    type: options.type,
    timestamp: new Date().toISOString(),
    schemaVersion: "v0",
    payload: {
      ...(options.waitId === undefined ? {} : { waitId: options.waitId }),
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      ...(options.answerFile === undefined
        ? {}
        : { artifactPaths: { answerFile: options.answerFile } }),
    },
  };
}

describe("wait-run-helpers branch-aware wait identity", () => {
  it("keeps same-id waits on different branches independent", () => {
    const startedA = waitEvent({
      type: "wait.started",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-a",
    });
    const startedB = waitEvent({
      type: "wait.started",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-b",
    });
    const satisfiedA = waitEvent({
      type: "wait.satisfied",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-a",
    });

    // Branch A's satisfaction must not resolve branch B's identical wait.
    const pending = findPendingWaitById([startedA, startedB, satisfiedA], "ask");
    expect(pending).toBe(startedB);
  });

  it("keeps same-id waits with identical answer file paths independent across branches", () => {
    const answerFile = "steps/0001-ask/waits/ask/answer.json";
    const startedA = waitEvent({
      type: "wait.started",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-a",
      answerFile,
    });
    const startedB = waitEvent({
      type: "wait.started",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-b",
      answerFile,
    });
    const satisfiedB = waitEvent({
      type: "wait.satisfied",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-b",
      answerFile,
    });

    const pending = findPendingWaitById([startedA, startedB, satisfiedB], "ask");
    expect(pending).toBe(startedA);
  });

  it("resolves a wait against its own branch satisfaction", () => {
    const started = waitEvent({
      type: "wait.started",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-a",
    });
    const satisfied = waitEvent({
      type: "wait.satisfied",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-a",
    });

    expect(findPendingWaitById([started, satisfied], "ask")).toBeUndefined();
  });

  it("treats undecorated events as the implicit root branch", () => {
    const started = waitEvent({ type: "wait.started", stepId: "ask", waitId: "ask" });
    const satisfied = waitEvent({
      type: "wait.satisfied",
      stepId: "ask",
      waitId: "ask",
      branchId: "root",
    });

    expect(findPendingWaitById([started, satisfied], "ask")).toBeUndefined();
    expect(findLatestPendingWait([started, satisfied])).toBeUndefined();
  });

  it("finds the latest pending wait across branches", () => {
    const startedA = waitEvent({
      type: "wait.started",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-a",
    });
    const startedB = waitEvent({
      type: "wait.started",
      stepId: "ask",
      waitId: "ask",
      branchId: "branch-b",
    });

    expect(findLatestPendingWait([startedA, startedB])).toBe(startedB);
    expect(findLatestPendingWait([startedA, startedB, startedA])).toBe(startedA);
  });
});
