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

export function connectRunEventStream(options: {
  readonly runId: string;
  readonly onState: (state: DashboardEventsState) => void;
  readonly initialState?: DashboardEventsState;
  readonly eventSourceFactory?: (url: string) => EventSource;
}): () => void {
  let state = options.initialState ?? { rows: [] };
  const createEventSource = options.eventSourceFactory ?? ((url: string) => new EventSource(url));
  const source = createEventSource(
    `/api/trailstep/runs/${encodeURIComponent(options.runId)}/events/stream`,
  );

  source.addEventListener("trailstep-event", (message) => {
    const event = JSON.parse(message.data) as Event;
    state = reduceDashboardEvents(state, { type: "events.received", events: [event] });
    options.onState(state);
  });

  return () => source.close();
}
