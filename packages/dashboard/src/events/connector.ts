import type { Event } from "@trailstep/core";
import type { DashboardRunSummary } from "../server/runs";
import { type DashboardEventsState, reduceDashboardEvents } from "./reducer";

export interface DashboardRunsResponse {
  readonly runs: readonly DashboardRunSummary[];
}

export async function fetchDashboardRuns(
  fetcher: typeof fetch = fetch,
): Promise<readonly DashboardRunSummary[]> {
  const response = await fetcher("/api/trailstep/runs");
  if (!response.ok) {
    throw new Error(`Unable to load TrailStep runs: ${response.status}`);
  }

  const body = (await response.json()) as DashboardRunsResponse;
  return body.runs;
}

export interface ConnectRunEventStreamOptions {
  readonly runId: string;
  readonly onState: (state: DashboardEventsState) => void;
  readonly initialState?: DashboardEventsState;
  readonly eventSourceFactory?: (url: string) => EventSource;
  /** Receives malformed frames that were reported and skipped. */
  readonly onError?: (error: unknown) => void;
}

export function connectRunEventStream(options: ConnectRunEventStreamOptions): () => void {
  let state = options.initialState ?? { rows: [] };
  const createEventSource = options.eventSourceFactory ?? ((url: string) => new EventSource(url));
  const source = createEventSource(
    `/api/trailstep/runs/${encodeURIComponent(options.runId)}/events/stream`,
  );

  source.addEventListener("trailstep-event", (message) => {
    const event = parseEventFrame(message.data);
    if (event === undefined) {
      reportStreamError(new Error("Received a malformed TrailStep event frame."), options.onError);
      return;
    }

    state = reduceDashboardEvents(state, { type: "events.received", events: [event] });
    options.onState(state);
  });

  return () => source.close();
}

/**
 * Parses one SSE frame into a TrailStep event.
 *
 * Returns `undefined` for frames that are not valid JSON or that do not carry
 * the event shape the dashboard reducer needs, so a single malformed frame
 * cannot crash the event stream.
 */
function parseEventFrame(data: unknown): Event | undefined {
  if (typeof data !== "string") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }

  if (!isEventLike(parsed)) {
    return undefined;
  }

  return parsed;
}

function isEventLike(value: unknown): value is Event {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    readonly id?: unknown;
    readonly type?: unknown;
    readonly timestamp?: unknown;
  };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.timestamp === "string"
  );
}

function reportStreamError(error: unknown, onError?: (error: unknown) => void): void {
  if (onError) {
    onError(error);
    return;
  }

  console.warn(
    `TrailStep dashboard: skipping malformed event frame: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
