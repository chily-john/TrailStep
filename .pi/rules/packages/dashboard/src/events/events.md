---
kind: rules
paths:
  - packages/dashboard/src/events/
summary: Browser-side dashboard run loading, SSE connection, and event-row state reduction.
triggers:
  - dashboard events
  - EventSource
  - dashboard reducer
  - fetch dashboard runs
---

# packages/dashboard/src/events/

Enter here when changing client-side dashboard data loading or event stream state.

## Rules

- Keep the server event name `stepkit-event` synchronized with `server/events.ts`.
- Deduplicate rows by event id before sorting.
- Sort rows by timestamp then id so repeated event batches remain stable.
- Return a close function from stream connectors so Svelte components can stop prior streams.
