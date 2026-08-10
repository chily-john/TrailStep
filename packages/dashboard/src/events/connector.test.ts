import { describe, expect, it, vi } from "vitest";

import { connectRunEventStream, fetchDashboardRuns } from "./connector";

describe("dashboard API connector", () => {
  it("fetches TrailStep dashboard runs from the project-owned API route", async () => {
    const fetcher = vi.fn(async () =>
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
});
