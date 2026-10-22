import { describe, expect, it, vi } from "vitest";

import { connectRunEventStream, fetchDashboardRuns } from "./connector";

describe("dashboard API connector", () => {
  it("fetches TrailStep dashboard runs from the project-owned API route", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ runs: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(fetchDashboardRuns(fetcher as unknown as typeof fetch)).resolves.toEqual([]);

    expect(fetcher).toHaveBeenCalledWith("/api/trailstep/runs");
  });

  it("subscribes to TrailStep run events on the project-owned API route and SSE event name", () => {
    const addEventListener = vi.fn();
    const close = vi.fn();
    const eventSourceFactory = vi.fn(() => ({ addEventListener, close }) as unknown as EventSource);

    const stop = connectRunEventStream({
      runId: "run a/b",
      onState: vi.fn(),
      eventSourceFactory,
    });

    expect(eventSourceFactory).toHaveBeenCalledWith(
      "/api/trailstep/runs/run%20a%2Fb/events/stream",
    );
    expect(addEventListener).toHaveBeenCalledWith("trailstep-event", expect.any(Function));

    stop();
    expect(close).toHaveBeenCalled();
  });

  it("reports and skips a malformed event frame without breaking the stream", () => {
    const { listener, close } = fakeEventSource();
    const onState = vi.fn();
    const onError = vi.fn();

    connectRunEventStream({
      runId: "run-a",
      onState,
      onError,
      eventSourceFactory: () =>
        ({ addEventListener: listener.add, close }) as unknown as EventSource,
    });

    expect(() => listener.emit("{not json")).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onState).not.toHaveBeenCalled();

    listener.emit(JSON.stringify(trailstepEvent("step.started")));
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0]?.[0]).toMatchObject({
      rows: [{ id: "event-1", type: "step.started" }],
    });
  });

  it("reports and skips a frame that is not a TrailStep event", () => {
    const { listener, close } = fakeEventSource();
    const onState = vi.fn();
    const onError = vi.fn();

    connectRunEventStream({
      runId: "run-a",
      onState,
      onError,
      eventSourceFactory: () =>
        ({ addEventListener: listener.add, close }) as unknown as EventSource,
    });

    expect(() => listener.emit(JSON.stringify({ hello: "world" }))).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onState).not.toHaveBeenCalled();
  });
});

function fakeEventSource(): {
  readonly listener: {
    readonly add: (type: string, handler: (message: { readonly data: string }) => void) => void;
    readonly emit: (data: string) => void;
  };
  readonly close: () => void;
} {
  let handler: ((message: { readonly data: string }) => void) | undefined;

  return {
    listener: {
      add: (_type, registered) => {
        handler = registered;
      },
      emit: (data) => {
        handler?.({ data });
      },
    },
    close: () => undefined,
  };
}

function trailstepEvent(type: string): Record<string, unknown> {
  return {
    id: "event-1",
    runId: "run-a",
    workflowId: "workflow-a",
    type,
    timestamp: "2026-01-02T03:00:00.000Z",
    schemaVersion: "v0",
    payload: {},
  };
}
