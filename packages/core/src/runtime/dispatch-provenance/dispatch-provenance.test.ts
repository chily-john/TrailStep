import { describe, expect, it } from "vitest";

import type { Event } from "../../contracts/events/event.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import {
  attachSpawnEventId,
  createDispatchProvenance,
  dispatchProvenanceFields,
  mergeDispatchProvenanceContext,
  readSpawnEventId,
  withDispatchProvenance,
} from "./dispatch-provenance.js";

function createTestEvent(payload: Record<string, unknown> = {}): Event {
  return {
    id: "evt_test",
    runId: "run-test",
    workflowId: "test-workflow",
    stepId: "review",
    type: "agent.spawned",
    timestamp: "2026-11-10T00:00:00.000Z",
    schemaVersion: "v0",
    payload,
  };
}

describe("createDispatchProvenance", () => {
  it("returns undefined for the legacy shape when no context is known", () => {
    expect(createDispatchProvenance(undefined)).toBeUndefined();
    expect(createDispatchProvenance({})).toBeUndefined();
    expect(dispatchProvenanceFields(undefined)).toEqual({});
    // Layer counters alone (e.g. a legacy direct working dispatch with no
    // step context) still record their known fields.
    expect(dispatchProvenanceFields(undefined, { targetOrdinal: 1 })).toEqual({
      provenance: { schemaVersion: 1, targetOrdinal: 1 },
    });
  });

  it("carries only allowlisted context, with its own schemaVersion first", () => {
    const provenance = createDispatchProvenance(
      {
        branchId: "root",
        stepIndex: 2,
        stepArtifactId: "0002-review",
        stepAttempt: 1,
        executionCwd: "/repo/worktree",
        promptPhaseIndex: 0,
      },
      { targetOrdinal: 1, workSpawnTry: 1, spawnEventId: "evt_spawn" },
    );

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      branchId: "root",
      stepIndex: 2,
      stepArtifactId: "0002-review",
      stepAttempt: 1,
      executionCwd: "/repo/worktree",
      promptPhaseIndex: 0,
      targetOrdinal: 1,
      workSpawnTry: 1,
      spawnEventId: "evt_spawn",
    });
    expect(Object.keys(provenance ?? {})).toEqual([
      "schemaVersion",
      "branchId",
      "stepIndex",
      "stepArtifactId",
      "stepAttempt",
      "executionCwd",
      "promptPhaseIndex",
      "targetOrdinal",
      "workSpawnTry",
      "spawnEventId",
    ]);
  });

  it("distinguishes layered retry counters and subprompt association", () => {
    const provenance = createDispatchProvenance(
      {
        branchId: "branch-a-1",
        parentStepId: "orchestrate",
        subPromptOrdinal: 2,
      },
      { targetOrdinal: 3, formatValidationAttempt: 2, formatSpawnTry: 1 },
    );

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      branchId: "branch-a-1",
      parentStepId: "orchestrate",
      subPromptOrdinal: 2,
      targetOrdinal: 3,
      formatValidationAttempt: 2,
      formatSpawnTry: 1,
    });
    expect(provenance).not.toHaveProperty("workSpawnTry");
    expect(provenance).not.toHaveProperty("stepAttempt");
    expect(provenance).not.toHaveProperty("spawnEventId");
  });

  it("never includes raw prompts, config, secrets, or file paths from the context", () => {
    const provenance = createDispatchProvenance(
      { branchId: "root", stepIndex: 1, executionCwd: "/repo" },
      {},
    );
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain("promptFile");
    expect(serialized).not.toContain("outputFile");
    expect(serialized).not.toContain("config");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("model");
  });
});

describe("mergeDispatchProvenanceContext", () => {
  it("lets patch fields win and preserves base fields for undefined patch values", () => {
    const merged = mergeDispatchProvenanceContext(
      { branchId: "branch-a-1", stepIndex: 1, stepAttempt: 1, executionCwd: "/repo" },
      { parentStepId: "orchestrate", subPromptOrdinal: 1, stepAttempt: undefined },
    );

    expect(merged).toEqual({
      branchId: "branch-a-1",
      stepIndex: 1,
      stepAttempt: 1,
      executionCwd: "/repo",
      parentStepId: "orchestrate",
      subPromptOrdinal: 1,
    });
  });

  it("does not mutate either input", () => {
    const base = { branchId: "root", stepIndex: 1 };
    const patch = { parentStepId: "orchestrate", subPromptOrdinal: 1 };
    const merged = mergeDispatchProvenanceContext(base, patch);
    expect(base).toEqual({ branchId: "root", stepIndex: 1 });
    expect(patch).toEqual({ parentStepId: "orchestrate", subPromptOrdinal: 1 });
    expect(merged).not.toBe(base);
    expect(merged).not.toBe(patch);
  });
});

describe("withDispatchProvenance", () => {
  it("appends the namespace after existing payload fields without reordering", () => {
    const event = createTestEvent({ provider: "worker", phase: "work" });
    const provenance = createDispatchProvenance({ branchId: "root", stepIndex: 1 });
    const decorated = withDispatchProvenance(event, provenance);

    expect(Object.keys(decorated.payload)).toEqual(["provider", "phase", "provenance"]);
    expect(decorated.payload.provenance).toMatchObject({
      schemaVersion: 1,
      branchId: "root",
      stepIndex: 1,
    });
    expect(decorated.id).toBe(event.id);
    expect(decorated).not.toBe(event);
  });

  it("is idempotent: repeated decoration preserves the first namespace and references", () => {
    const event = createTestEvent({ provider: "worker" });
    const first = createDispatchProvenance(
      { branchId: "root", stepIndex: 1 },
      {
        spawnEventId: "evt_first",
      },
    );
    const second = createDispatchProvenance(
      { branchId: "root", stepIndex: 1 },
      {
        spawnEventId: "evt_second",
      },
    );

    const once = withDispatchProvenance(event, first);
    const twice = withDispatchProvenance(once, second);
    expect(twice).toBe(once);
    expect(twice.payload.provenance).toMatchObject({ spawnEventId: "evt_first" });
  });

  it("returns the event unchanged when provenance is undefined", () => {
    const event = createTestEvent({ provider: "worker" });
    expect(withDispatchProvenance(event, undefined)).toBe(event);
  });
});

describe("attachSpawnEventId / readSpawnEventId", () => {
  it("attaches the spawn event ID to structured failure details", () => {
    const failureError = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "boom",
      details: { exitCode: 7 },
    });

    const attached = attachSpawnEventId(failureError, "evt_spawn");
    expect(readSpawnEventId((attached as typeof failureError).failure.details)).toBe("evt_spawn");
    expect((attached as typeof failureError).failure.details).toMatchObject({ exitCode: 7 });
  });

  it("first spawn reference wins on repeated attachment", () => {
    const failureError = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "boom",
      details: { spawnEventId: "evt_first" },
    });
    const attached = attachSpawnEventId(failureError, "evt_second");
    expect(attached).toBe(failureError);
  });

  it("leaves non-structured errors untouched", () => {
    const cancellationLike = new Error("cancelled");
    expect(attachSpawnEventId(cancellationLike, "evt_spawn")).toBe(cancellationLike);
    expect(attachSpawnEventId("string error", "evt_spawn")).toBe("string error");
    expect(readSpawnEventId(undefined)).toBeUndefined();
    expect(readSpawnEventId({ spawnEventId: 42 })).toBeUndefined();
  });
});
