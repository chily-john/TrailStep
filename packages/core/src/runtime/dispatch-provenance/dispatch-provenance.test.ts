import { describe, expect, it } from "vitest";

import type { Event } from "../../contracts/events/event.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import {
  correlateSpawnEventId,
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

describe("correlateSpawnEventId / readSpawnEventId", () => {
  it("correlates by identity without replacing the error or its details", () => {
    const details = { exitCode: 7 };
    const failureError = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "boom",
      details,
    });
    const stack = failureError.stack;

    const correlated = correlateSpawnEventId(failureError, "evt_spawn");
    // Same object, same stack, same details reference — never a replacement.
    expect(correlated).toBe(failureError);
    expect(correlated).toBe(failureError);
    expect((correlated as TrailStepFailureError).failure.details).toBe(details);
    expect((correlated as TrailStepFailureError).failure.details).toEqual({ exitCode: 7 });
    expect((correlated as TrailStepFailureError).stack).toBe(stack);
    expect(readSpawnEventId(correlated)).toBe("evt_spawn");
  });

  it("preserves non-record details (arrays, strings, null, undefined) by reference", () => {
    const arrayDetails: unknown = ["keep-me"];
    const forArray = new TrailStepFailureError({
      code: "agent_output_invalid",
      message: "sentinel",
      details: arrayDetails,
      retryable: true,
    });
    const arrayStack = forArray.stack;
    expect(correlateSpawnEventId(forArray, "evt_actual")).toBe(forArray);
    expect(forArray.failure.details).toBe(arrayDetails);
    expect(forArray.stack).toBe(arrayStack);
    expect(forArray.failure.retryable).toBe(true);
    expect(readSpawnEventId(forArray)).toBe("evt_actual");
    // The raw failure must not gain a spawnEventId anywhere.
    expect(forArray.failure.details).toEqual(["keep-me"]);
    expect(JSON.stringify(forArray.failure)).not.toContain("spawnEventId");

    const stringDetails: unknown = "plain-string-details";
    const forString = new TrailStepFailureError({
      code: "agent_output_invalid",
      message: "sentinel",
      details: stringDetails,
    });
    expect(correlateSpawnEventId(forString, "evt_actual")).toBe(forString);
    expect(forString.failure.details).toBe(stringDetails);
    expect(readSpawnEventId(forString)).toBe("evt_actual");

    const forNull = new TrailStepFailureError({
      code: "agent_output_invalid",
      message: "sentinel",
      details: null,
    });
    expect(correlateSpawnEventId(forNull, "evt_actual")).toBe(forNull);
    expect(forNull.failure.details).toBeNull();
    expect(readSpawnEventId(forNull)).toBe("evt_actual");

    const forUndefined = new TrailStepFailureError({
      code: "agent_output_invalid",
      message: "sentinel",
    });
    expect(correlateSpawnEventId(forUndefined, "evt_actual")).toBe(forUndefined);
    expect(forUndefined.failure.details).toBeUndefined();
    expect(readSpawnEventId(forUndefined)).toBe("evt_actual");
  });

  it("correlates frozen errors without mutating them", () => {
    const frozen = Object.freeze(
      new TrailStepFailureError({
        code: "agent_provider_failed",
        message: "frozen",
        details: Object.freeze({ exitCode: 1 }),
      }),
    );
    expect(correlateSpawnEventId(frozen, "evt_frozen")).toBe(frozen);
    expect(readSpawnEventId(frozen)).toBe("evt_frozen");
    expect(frozen.failure.details).toEqual({ exitCode: 1 });
  });

  it("first spawn reference wins on repeated correlation", () => {
    const failureError = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "boom",
      details: { exitCode: 7 },
    });
    const first = correlateSpawnEventId(failureError, "evt_first");
    const second = correlateSpawnEventId(failureError, "evt_second");
    expect(second).toBe(first);
    expect(second).toBe(failureError);
    expect(readSpawnEventId(failureError)).toBe("evt_first");
  });

  it("correlates plain and cancellation-like errors by identity; primitives pass through", () => {
    const cancellationLike = new Error("cancelled");
    expect(correlateSpawnEventId(cancellationLike, "evt_spawn")).toBe(cancellationLike);
    expect(readSpawnEventId(cancellationLike)).toBe("evt_spawn");
    expect(correlateSpawnEventId("string error", "evt_spawn")).toBe("string error");
    expect(readSpawnEventId("string error")).toBeUndefined();
    expect(readSpawnEventId(undefined)).toBeUndefined();
    expect(readSpawnEventId({ spawnEventId: "evt_details_only" })).toBeUndefined();
  });

  it("keeps correlations isolated per error instance (no cross-attempt leakage)", () => {
    const first = new TrailStepFailureError({ code: "a", message: "first" });
    const second = new TrailStepFailureError({ code: "b", message: "second" });
    correlateSpawnEventId(first, "evt_one");
    correlateSpawnEventId(second, "evt_two");
    expect(readSpawnEventId(first)).toBe("evt_one");
    expect(readSpawnEventId(second)).toBe("evt_two");
  });
});
