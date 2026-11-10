import { describe, expect, it } from "vitest";

import type { Event } from "../../contracts/events/event.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import {
  createDispatchProvenance,
  dispatchProvenanceFields,
  mergeDispatchProvenanceContext,
  withDispatchProvenance,
} from "./dispatch-provenance.js";
import { createSpawnFailureScope } from "./spawn-failure-correlation.js";

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

describe("SpawnFailureScope", () => {
  it("correlates by identity without replacing the error or its details", () => {
    const details = { exitCode: 7 };
    const failureError = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "boom",
      details,
    });
    const stack = failureError.stack;
    const scope = createSpawnFailureScope();

    scope.record(failureError, "evt_spawn");

    // Same object, same stack, same details reference — record never mutates.
    expect(failureError.failure.details).toBe(details);
    expect(failureError.failure.details).toEqual({ exitCode: 7 });
    expect(failureError.stack).toBe(stack);
    expect(scope.read(failureError)).toBe("evt_spawn");
    scope.close();
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
    const scopeArray = createSpawnFailureScope();
    scopeArray.record(forArray, "evt_actual");
    expect(forArray.failure.details).toBe(arrayDetails);
    expect(forArray.stack).toBe(arrayStack);
    expect(forArray.failure.retryable).toBe(true);
    expect(scopeArray.read(forArray)).toBe("evt_actual");
    expect(forArray.failure.details).toEqual(["keep-me"]);
    expect(JSON.stringify(forArray.failure)).not.toContain("spawnEventId");
    scopeArray.close();

    const stringDetails: unknown = "plain-string-details";
    const forString = new TrailStepFailureError({
      code: "agent_output_invalid",
      message: "sentinel",
      details: stringDetails,
    });
    const scopeString = createSpawnFailureScope();
    scopeString.record(forString, "evt_actual");
    expect(forString.failure.details).toBe(stringDetails);
    expect(scopeString.read(forString)).toBe("evt_actual");
    scopeString.close();

    const forNull = new TrailStepFailureError({
      code: "agent_output_invalid",
      message: "sentinel",
      details: null,
    });
    const scopeNull = createSpawnFailureScope();
    scopeNull.record(forNull, "evt_actual");
    expect(forNull.failure.details).toBeNull();
    expect(scopeNull.read(forNull)).toBe("evt_actual");
    scopeNull.close();

    const forUndefined = new TrailStepFailureError({
      code: "agent_output_invalid",
      message: "sentinel",
    });
    const scopeUndefined = createSpawnFailureScope();
    scopeUndefined.record(forUndefined, "evt_actual");
    expect(forUndefined.failure.details).toBeUndefined();
    expect(scopeUndefined.read(forUndefined)).toBe("evt_actual");
    scopeUndefined.close();
  });

  it("correlates frozen errors and functions without mutating them", () => {
    const frozen = Object.freeze(
      new TrailStepFailureError({
        code: "agent_provider_failed",
        message: "frozen",
        details: Object.freeze({ exitCode: 1 }),
      }),
    );
    const frozenScope = createSpawnFailureScope();
    frozenScope.record(frozen, "evt_frozen");
    expect(frozenScope.read(frozen)).toBe("evt_frozen");
    expect(frozen.failure.details).toEqual({ exitCode: 1 });
    frozenScope.close();

    const fn = Object.assign(function thrownFunction() {}, { code: "fn" });
    const fnScope = createSpawnFailureScope();
    fnScope.record(fn, "evt_fn");
    expect(fnScope.read(fn)).toBe("evt_fn");
    expect((fn as unknown as { code: string }).code).toBe("fn");
    fnScope.close();
  });

  it("treats identical re-association as idempotent and conflicts as permanently ambiguous", () => {
    const failureError = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "boom",
      details: { exitCode: 7 },
    });
    const scope = createSpawnFailureScope();
    scope.record(failureError, "evt_first");
    scope.record(failureError, "evt_first");
    expect(scope.read(failureError)).toBe("evt_first");
    // Same error with a different spawn ID is a conflict: absent afterwards.
    scope.record(failureError, "evt_second");
    expect(scope.read(failureError)).toBeUndefined();
    // Ambiguity is permanent: later identical writes cannot revive it.
    scope.record(failureError, "evt_first");
    expect(scope.read(failureError)).toBeUndefined();
    scope.close();

    const other = new Error("other");
    const mismatched = createSpawnFailureScope();
    mismatched.record(failureError, "evt_a");
    mismatched.record(other, "evt_a");
    expect(mismatched.read(failureError)).toBeUndefined();
    expect(mismatched.read(other)).toBeUndefined();
    mismatched.close();
  });

  it("keeps each scope isolated so a reused error never keeps an earlier spawn", () => {
    const shared = Object.freeze(
      new TrailStepFailureError({
        code: "agent_output_invalid",
        message: "sentinel",
        details: Object.freeze(["keep-me"]),
      }),
    );
    const firstScope = createSpawnFailureScope();
    const secondScope = createSpawnFailureScope();
    firstScope.record(shared, "evt_attempt_1");
    expect(firstScope.read(shared)).toBe("evt_attempt_1");
    firstScope.close();
    // A fresh scope for the next attempt must not see the earlier binding.
    expect(secondScope.read(shared)).toBeUndefined();
    secondScope.record(shared, "evt_attempt_2");
    expect(secondScope.read(shared)).toBe("evt_attempt_2");
    secondScope.close();
    // Closed scopes never resurface a stale binding on late reads/writes.
    expect(firstScope.read(shared)).toBeUndefined();
    firstScope.record(shared, "evt_late");
    expect(firstScope.read(shared)).toBeUndefined();
  });

  it("forwards a matching child association and stays idempotent through nested forwards", () => {
    const failureError = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "boom",
      details: { exitCode: 7 },
    });
    const leaf = createSpawnFailureScope();
    const middle = createSpawnFailureScope();
    const root = createSpawnFailureScope();
    leaf.record(failureError, "evt_leaf");
    middle.forward(failureError, leaf);
    expect(middle.read(failureError)).toBe("evt_leaf");
    root.forward(failureError, middle);
    expect(root.read(failureError)).toBe("evt_leaf");
    // Repeated forward of the identical association is idempotent.
    root.forward(failureError, middle);
    expect(root.read(failureError)).toBe("evt_leaf");
    leaf.close();
    middle.close();
    root.close();
  });

  it("preserves forwarded ambiguity and invalidates stale parents on missing, mismatched, or closed children", () => {
    const failureError = new TrailStepFailureError({
      code: "agent_provider_failed",
      message: "boom",
      details: { exitCode: 7 },
    });
    // Ambiguous leaf -> ambiguous parent, and later writes cannot revive.
    const ambiguousLeaf = createSpawnFailureScope();
    ambiguousLeaf.record(failureError, "evt_a");
    ambiguousLeaf.record(failureError, "evt_b");
    expect(ambiguousLeaf.read(failureError)).toBeUndefined();
    const ambiguousParent = createSpawnFailureScope();
    ambiguousParent.forward(failureError, ambiguousLeaf);
    expect(ambiguousParent.read(failureError)).toBeUndefined();
    ambiguousParent.record(failureError, "evt_a");
    expect(ambiguousParent.read(failureError)).toBeUndefined();
    ambiguousLeaf.close();
    ambiguousParent.close();

    // Missing child (empty) does not preserve a stale parent binding.
    const emptyChild = createSpawnFailureScope();
    const staleParent = createSpawnFailureScope();
    staleParent.record(failureError, "evt_stale");
    staleParent.forward(failureError, emptyChild);
    expect(staleParent.read(failureError)).toBeUndefined();
    emptyChild.close();
    staleParent.close();

    // Mismatched child reference invalidates a stale parent binding.
    const boundToOther = createSpawnFailureScope();
    boundToOther.record(new Error("other"), "evt_other");
    const mismatchedParent = createSpawnFailureScope();
    mismatchedParent.record(failureError, "evt_stale");
    mismatchedParent.forward(failureError, boundToOther);
    expect(mismatchedParent.read(failureError)).toBeUndefined();
    boundToOther.close();
    mismatchedParent.close();

    // Closed child behaves as missing: no fallback to an earlier binding.
    const closedChild = createSpawnFailureScope();
    closedChild.record(failureError, "evt_closed_child");
    closedChild.close();
    const closedParent = createSpawnFailureScope();
    closedParent.record(failureError, "evt_stale");
    closedParent.forward(failureError, closedChild);
    expect(closedParent.read(failureError)).toBeUndefined();
    closedParent.close();

    // Missing child with an empty parent stays absent (no fabricated link).
    const emptyParent = createSpawnFailureScope();
    const stillEmpty = createSpawnFailureScope();
    emptyParent.forward(failureError, stillEmpty);
    expect(emptyParent.read(failureError)).toBeUndefined();
    stillEmpty.close();
    emptyParent.close();
  });

  it("leaves primitives uncorrelated and never reads from failure.details", () => {
    const cancellationLike = new Error("cancelled");
    const scope = createSpawnFailureScope();
    scope.record(cancellationLike, "evt_spawn");
    expect(scope.read(cancellationLike)).toBe("evt_spawn");
    // Primitives pass through with no association, even after record/forward.
    scope.record("string error", "evt_x");
    expect(scope.read("string error")).toBeUndefined();
    expect(scope.read(undefined)).toBeUndefined();
    expect(scope.read(null)).toBeUndefined();
    expect(scope.read(42)).toBeUndefined();
    scope.close();

    const primitiveScope = createSpawnFailureScope();
    primitiveScope.record("string error", "evt_spawn");
    expect(primitiveScope.read("string error")).toBeUndefined();
    primitiveScope.close();

    // An object carrying a spawnEventId field is not a correlation source.
    const detailsOnly = createSpawnFailureScope();
    expect(detailsOnly.read({ spawnEventId: "evt_details_only" })).toBeUndefined();
    detailsOnly.close();
  });

  it("close is idempotent, clears references, and ignores late writes", () => {
    const failureError = new Error("boom");
    const scope = createSpawnFailureScope();
    scope.record(failureError, "evt_spawn");
    expect(scope.read(failureError)).toBe("evt_spawn");
    scope.close();
    expect(scope.read(failureError)).toBeUndefined();
    expect((): void => scope.close()).not.toThrow();
    expect(scope.read(failureError)).toBeUndefined();
    const child = createSpawnFailureScope();
    child.record(failureError, "evt_child");
    child.close();
    scope.record(failureError, "evt_spawn");
    scope.forward(failureError, child);
    expect(scope.read(failureError)).toBeUndefined();
  });
});
