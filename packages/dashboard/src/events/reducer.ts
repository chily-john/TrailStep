import type { Event } from "@trailstep/core";

export interface DashboardEventRow {
  readonly id: string;
  readonly timestamp: string;
  readonly type: Event["type"];
  readonly stepId?: string;
}

export interface DashboardEventsState {
  readonly rows: readonly DashboardEventRow[];
}

export type DashboardEventsAction = {
  readonly type: "events.received";
  readonly events: readonly Event[];
};

export function reduceDashboardEvents(
  state: DashboardEventsState,
  action: DashboardEventsAction,
): DashboardEventsState {
  const rowsById = new Map(state.rows.map((row) => [row.id, row]));

  for (const event of action.events) {
    if (rowsById.has(event.id)) {
      continue;
    }

    rowsById.set(event.id, {
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      stepId: event.stepId,
    });
  }

  return {
    rows: [...rowsById.values()].sort(compareRowsByTimestampThenId),
  };
}

function compareRowsByTimestampThenId(left: DashboardEventRow, right: DashboardEventRow): number {
  const timestampOrder = left.timestamp.localeCompare(right.timestamp);
  return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder;
}
