---
kind: rules
paths:
  - packages/core/src/runtime/events/
summary: Runtime event object construction for persisted workflow and step event streams.
triggers:
  - create event
  - runtime event
  - event schema
  - event id
---

# packages/core/src/runtime/events/

Enter here when changing the shared event shape produced by runtime modules.

## Rules

- Keep event types synchronized with `RunWorkflowOptions`/`Event` types and dashboard consumers.
- Event ids are `evt_`-prefixed UUIDs; keep them unique across module reloads and retry histories, treat them as opaque, and use JSONL/replay order for ordering assumptions.
- Event payloads are persisted to disk; avoid adding sensitive data without a documented redaction decision.
