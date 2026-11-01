import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  done,
  type Event,
  runWorkflow,
  step,
  TrailStepFailureError,
  type Workflow,
} from "../../index.js";
import { appendEvent, createRunDirectory } from "../artifacts/run-storage.js";
import {
  isRetryableStepFailure,
  shouldRetryStepFailure,
  TRANSIENT_FAILURE_CODES,
} from "./retryable-failures.js";

function eventTypes(events: readonly Event[]): readonly string[] {
  return events.map((event) => event.type);
}

function transientProviderFailure(): TrailStepFailureError {
  return new TrailStepFailureError({
    code: "agent_provider_unavailable",
    message: "provider unavailable",
  });
}

describe("automatic step retry classification", () => {
  it("does not retry a deterministic failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-classify-"));
    let runs = 0;

    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "deterministic-failure-workflow",
      start() {
        return step({ id: "boom" }).do(() => {
          runs += 1;
          throw new Error("deterministic boom");
        })({});
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "deterministic-failure",
      cwd,
    });

    expect(result.status).toBe("failure");
    if (result.status === "success") {
      throw new Error("expected the workflow to fail");
    }
    // A deterministic failure is permanent: the step runs exactly once and no
    // attemptFailed event is emitted.
    expect(runs).toBe(1);
    expect(result.failure.code).toBe("step_execution_failed");
    expect(eventTypes(result.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it("retries a transient failure and records the failed attempt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-classify-"));
    let runs = 0;

    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "transient-failure-workflow",
      start() {
        return step({ id: "flaky" }).do(() => {
          runs += 1;
          throw transientProviderFailure();
        })({});
      },
    };

    const result = await runWorkflow({ workflow, input: {}, runName: "transient-failure", cwd });

    expect(result.status).toBe("failure");
    if (result.status === "success") {
      throw new Error("expected the workflow to fail");
    }
    expect(runs).toBe(2);
    expect(eventTypes(result.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.attemptFailed",
      "step.failed",
      "workflow.failed",
    ]);

    const attemptFailed = result.events.find((event) => event.type === "step.attemptFailed");
    expect(attemptFailed?.payload).toMatchObject({
      attempt: 1,
      maxAttempts: 2,
      // The first dispatch of the step, so amplification is 1 — not 0 and not a per-attempt 1.
      agentDispatches: 1,
      failure: { code: "agent_provider_unavailable", message: "provider unavailable" },
    });
  });

  it("retries a deterministic failure when retryOn is always", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-classify-"));
    let runs = 0;

    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "always-retry-workflow",
      start() {
        return step({ id: "boom", retry: { retryOn: "always" } }).do(() => {
          runs += 1;
          throw new Error("deterministic boom");
        })({});
      },
    };

    const result = await runWorkflow({ workflow, input: {}, runName: "always-retry", cwd });

    expect(result.status).toBe("failure");
    expect(runs).toBe(2);
    expect(eventTypes(result.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.attemptFailed",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it("retries a deterministic failure when the global settings opt into always", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-classify-"));
    let runs = 0;

    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "global-always-retry-workflow",
      start() {
        return step({ id: "boom" }).do(() => {
          runs += 1;
          throw new Error("deterministic boom");
        })({});
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "global-always-retry",
      cwd,
      trailstepConfig: {
        version: 1,
        agents: {},
        settings: { retry: { retryOn: "always" } },
      },
    });

    expect(result.status).toBe("failure");
    expect(runs).toBe(2);
    expect(eventTypes(result.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.attemptFailed",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it("never retries when maxAttempts is 1", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-classify-"));
    let runs = 0;

    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "single-attempt-workflow",
      start() {
        return step({ id: "flaky", retry: { maxAttempts: 1 } }).do(() => {
          runs += 1;
          throw transientProviderFailure();
        })({});
      },
    };

    const result = await runWorkflow({ workflow, input: {}, runName: "single-attempt", cwd });

    expect(result.status).toBe("failure");
    expect(runs).toBe(1);
    expect(eventTypes(result.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it("reconstructs the attempt count from the event trail after a crash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-classify-"));
    let runs = 0;

    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "crashed-attempt-workflow",
      start() {
        return step({ id: "flaky", retry: { maxAttempts: 3 } }).do(() => {
          runs += 1;
          throw transientProviderFailure();
        })({});
      },
    };

    // Simulate a crash: the first attempt failed transiently and its
    // step.attemptFailed event was persisted, but the process died before the
    // retry could run.
    const { runDir } = await createRunDirectory({ cwd, runName: "crashed-attempt" });
    await appendEvent(runDir, {
      id: "workflow-started",
      runId: "crashed-attempt",
      workflowId: "crashed-attempt-workflow",
      type: "workflow.started",
      timestamp: "2026-01-01T00:00:00.000Z",
      schemaVersion: "v0",
      payload: { input: {} },
    });
    await appendEvent(runDir, {
      id: "flaky-started",
      runId: "crashed-attempt",
      workflowId: "crashed-attempt-workflow",
      stepId: "flaky",
      type: "step.started",
      timestamp: "2026-01-01T00:00:00.000Z",
      schemaVersion: "v0",
      payload: { stepName: "flaky" },
    });
    await appendEvent(runDir, {
      id: "flaky-attempt-failed",
      runId: "crashed-attempt",
      workflowId: "crashed-attempt-workflow",
      stepId: "flaky",
      type: "step.attemptFailed",
      timestamp: "2026-01-01T00:00:00.000Z",
      schemaVersion: "v0",
      payload: {
        attempt: 1,
        maxAttempts: 3,
        failure: { code: "agent_provider_unavailable", message: "provider unavailable" },
      },
    });

    const retried = await runWorkflow({ workflow, retry: { runDir, kind: "manual" } });

    expect(retried.status).toBe("failure");
    if (retried.status === "success") {
      throw new Error("expected the workflow to fail");
    }
    // The attempt counter is reconstructed from the persisted event trail, so
    // the resumed run continues at attempt 2 and only two of the three
    // budgeted attempts remain.
    expect(runs).toBe(2);
    const attemptFailures = retried.events.filter((event) => event.type === "step.attemptFailed");
    expect(attemptFailures).toHaveLength(2);
    expect(attemptFailures[0]?.payload).toMatchObject({ attempt: 1, maxAttempts: 3 });
    // The attempt number is already absolute (persisted failures + in-process attempts), so it
    // doubles as the cumulative dispatch count across the crash boundary.
    expect(attemptFailures[1]?.payload).toMatchObject({
      attempt: 2,
      maxAttempts: 3,
      agentDispatches: 2,
    });
  });

  it("never re-executes a non-idempotent do phase", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-classify-"));
    let runs = 0;

    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "non-idempotent-workflow",
      start() {
        return step({ id: "side-effect" }).do(
          () => {
            runs += 1;
            throw transientProviderFailure();
          },
          { idempotent: false },
        )({});
      },
    };

    const failed = await runWorkflow({ workflow, input: {}, runName: "non-idempotent", cwd });

    expect(failed.status).toBe("failure");
    // The step failed transiently, but a non-idempotent do phase is never
    // re-executed automatically.
    expect(runs).toBe(1);
    expect(eventTypes(failed.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);

    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
    });

    expect(retried.status).toBe("failure");
    if (retried.status === "success") {
      throw new Error("expected the workflow to fail");
    }
    expect(retried.failure.code).toBe("resume_non_idempotent_step");
    // The non-idempotent phase was not run again.
    expect(runs).toBe(1);
  });

  it("succeeds after a transient failure clears", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-classify-"));
    let runs = 0;

    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "transient-recovers-workflow",
      start() {
        return step({ id: "flaky" }).do(() => {
          runs += 1;
          if (runs === 1) {
            throw transientProviderFailure();
          }

          return done({ ok: true });
        })({});
      },
    };

    const result = await runWorkflow({ workflow, input: {}, runName: "transient-recovers", cwd });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(runs).toBe(2);
    expect(result.output).toEqual({ ok: true });
    expect(eventTypes(result.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.attemptFailed",
      "step.completed",
      "workflow.completed",
    ]);
  });
});

describe("retryable failure allowlist", () => {
  it("classifies every transient failure code as retryable", () => {
    for (const code of TRANSIENT_FAILURE_CODES) {
      expect(isRetryableStepFailure({ code, message: code })).toBe(true);
      expect(shouldRetryStepFailure({ code, message: code }, "transient")).toBe(true);
    }
  });

  it("pins the exact transient allowlist", () => {
    // Adding a code here is a product decision: the allowlist must stay narrow enough that a
    // deterministic failure never burns a second agent dispatch.
    expect([...TRANSIENT_FAILURE_CODES].sort()).toEqual([
      "agent_output_invalid_json",
      "agent_output_unreadable",
      "agent_provider_failed",
      "agent_provider_output_invalid",
      "agent_provider_spawn_error",
      "agent_provider_timeout",
      "agent_provider_unavailable",
      "interactive_output_incomplete",
      "interactive_output_invalid",
      "step_timeout",
    ]);
  });

  it.each([
    "validation_failed",
    "agent_target_exhausted",
    "invalid_continuation",
    "missing_agent_config",
    "max_steps_exceeded",
  ])("keeps %s permanent under retryOn transient", (code) => {
    expect(isRetryableStepFailure({ code, message: code })).toBe(false);
    expect(shouldRetryStepFailure({ code, message: code }, "transient")).toBe(false);
  });

  it("keeps an unknown failure code permanent", () => {
    // Pins the allowlist design against a future "just add a default" refactor.
    expect(isRetryableStepFailure({ code: "some_future_code", message: "unknown" })).toBe(false);
    expect(
      shouldRetryStepFailure({ code: "some_future_code", message: "unknown" }, "transient"),
    ).toBe(false);
  });

  it("still honors explicit retryable opt-ins", () => {
    expect(
      isRetryableStepFailure({ code: "validation_failed", message: "invalid", retryable: true }),
    ).toBe(true);
    expect(
      isRetryableStepFailure({
        code: "validation_failed",
        message: "invalid",
        details: { retryable: true },
      }),
    ).toBe(true);
  });

  it("retries a permanent failure only when retryOn is always", () => {
    const failure = { code: "validation_failed", message: "invalid" };
    expect(shouldRetryStepFailure(failure, "always")).toBe(true);
    expect(shouldRetryStepFailure(failure, "transient")).toBe(false);
  });
});
