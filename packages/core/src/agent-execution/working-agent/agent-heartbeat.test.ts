import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";
import { startAgentHeartbeat } from "./agent-heartbeat.js";
import { createAgentProgressTracker } from "./liveness/agent-progress-tracker.js";

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

  it("reports the tracker's wall-clock elapsed time instead of the interval counter", async () => {
    let trackerNow = 7_000;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => trackerNow });
    const emit = vi.fn(async (_event: Event) => undefined);
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe: () => "Working agent step review",
      intervalMs: 10,
      tracker,
    });

    await vi.advanceTimersByTimeAsync(10);
    trackerNow = 123_456;
    await vi.advanceTimersByTimeAsync(10);

    const payloads = emit.mock.calls.map((call) => (call[0] as Event).payload);
    expect(payloads.map((payload) => payload.message)).toEqual([
      "Working agent step review still running (elapsed 7000)",
      "Working agent step review still running (elapsed 123456)",
    ]);
    expect(payloads.map((payload) => (payload.data as { elapsedMs: number }).elapsedMs)).toEqual([
      7_000, 123_456,
    ]);

    heartbeat.stop();
  });

  it("reports output liveness fields from the tracker", async () => {
    let trackerNow = 0;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => trackerNow });
    tracker.markSpawned(4_242);
    trackerNow = 200;
    tracker.recordOutput(12);
    trackerNow = 350;
    const emit = vi.fn(async (_event: Event) => undefined);
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe: () => "Working agent step review",
      intervalMs: 10,
      tracker,
    });

    await vi.advanceTimersByTimeAsync(10);

    const event = emit.mock.calls[0]?.[0] as Event;
    expect(event.payload.data).toEqual({
      heartbeat: true,
      elapsedMs: 350,
      outputBytes: 12,
      msSinceLastOutput: 150,
      exited: false,
      pid: 4_242,
    });

    heartbeat.stop();
  });

  it("emits a single agent.stalled event and calls onStall once", async () => {
    let trackerNow = 0;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => trackerNow });
    const emit = vi.fn(async (_event: Event) => undefined);
    const onStall = vi.fn();
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe: () => "Working agent step review",
      intervalMs: 100,
      tracker,
      stallTimeoutMs: 1_000,
      onStall,
    });

    await vi.advanceTimersByTimeAsync(100);
    trackerNow = 1_500;
    await vi.advanceTimersByTimeAsync(500);

    const stalledEvents = emit.mock.calls
      .map((call) => call[0] as Event)
      .filter((event) => event.type === "agent.stalled");
    expect(stalledEvents).toHaveLength(1);
    expect(stalledEvents[0]?.payload.message).toBe(
      "Working agent step review produced no output for 1500ms",
    );
    expect(stalledEvents[0]?.payload.data).toEqual({
      elapsedMs: 1_500,
      outputBytes: 0,
      msSinceLastOutput: 1_500,
      exited: false,
      stallTimeoutMs: 1_000,
    });
    expect(onStall).toHaveBeenCalledTimes(1);

    heartbeat.stop();
  });

  it("never reports a stall while output keeps arriving", async () => {
    let trackerNow = 0;
    const tracker = createAgentProgressTracker({ startedAt: 0, now: () => trackerNow });
    const emit = vi.fn(async (_event: Event) => undefined);
    const onStall = vi.fn();
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe: () => "Working agent step review",
      intervalMs: 100,
      tracker,
      stallTimeoutMs: 1_000,
      onStall,
    });

    for (let tick = 0; tick < 5; tick += 1) {
      trackerNow += 100;
      tracker.recordOutput(1);
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(emit.mock.calls.map((call) => (call[0] as Event).type)).toEqual([
      "step.progress",
      "step.progress",
      "step.progress",
      "step.progress",
      "step.progress",
    ]);
    expect(onStall).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  it("behaves exactly as before when no tracker is supplied", async () => {
    const emit = vi.fn(async (_event: Event) => undefined);
    const heartbeat = startAgentHeartbeat({
      emit,
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "review",
      describe: () => "Working agent step review",
      intervalMs: 10,
      stallTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(20);

    const events = emit.mock.calls.map((call) => call[0] as Event);
    expect(events.map((event) => event.type)).toEqual(["step.progress", "step.progress"]);
    expect(events.map((event) => event.payload.data)).toEqual([
      { heartbeat: true, elapsedMs: 10 },
      { heartbeat: true, elapsedMs: 20 },
    ]);

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
