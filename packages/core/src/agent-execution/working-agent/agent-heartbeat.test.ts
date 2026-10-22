import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";
import { startAgentHeartbeat } from "./agent-heartbeat.js";

describe("startAgentHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TRAILSTEP_AGENT_HEARTBEAT_INTERVAL_MS;
  });

  it("emits a step.progress heartbeat while the agent step is still pending", async () => {
    const emit = vi.fn(async (_event: Event) => {
      // Never resolves: the agent step has not finished yet.
      await new Promise<void>(() => undefined);
    });
    const describe = vi.fn(() => "Working agent step review");
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe,
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]?.[0] as Event;
    expect(event.type).toBe("step.progress");
    expect(event.runId).toBe("run-1");
    expect(event.workflowId).toBe("workflow-1");
    expect(event.stepId).toBe("review");
    expect(event.payload.message).toBe("Working agent step review still running (elapsed 10)");
    expect(event.payload.data).toEqual({ heartbeat: true, elapsedMs: 10 });

    heartbeat.stop();
  });

  it("emits successive heartbeats with growing elapsed time and stops on stop()", async () => {
    const emit = vi.fn(async (_event: Event) => undefined);
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe: () => "Working agent step review",
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(35);

    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls.map((call) => (call[0] as Event).payload.message)).toEqual([
      "Working agent step review still running (elapsed 10)",
      "Working agent step review still running (elapsed 20)",
      "Working agent step review still running (elapsed 30)",
    ]);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(emit).toHaveBeenCalledTimes(3);
  });

  it("tolerates heartbeat emit failures while still honoring stop()", async () => {
    const emit = vi.fn(async () => {
      throw new Error("emit failed");
    });
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe: () => "Working agent step review",
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(20);

    expect(emit).toHaveBeenCalledTimes(2);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("disables the heartbeat when intervalMs is 0", async () => {
    const emit = vi.fn(async () => undefined);
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe: () => "Working agent step review",
      intervalMs: 0,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(emit).not.toHaveBeenCalled();
    heartbeat.stop();
  });

  it("honors the TRAILSTEP_AGENT_HEARTBEAT_INTERVAL_MS env override", async () => {
    process.env.TRAILSTEP_AGENT_HEARTBEAT_INTERVAL_MS = "5";

    const emit = vi.fn(async () => undefined);
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe: () => "Working agent step review",
    });

    await vi.advanceTimersByTimeAsync(5);

    expect(emit).toHaveBeenCalledTimes(1);

    heartbeat.stop();
  });
});
