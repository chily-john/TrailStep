---
kind: rules
paths:
  - packages/dashboard/src/server/
summary: Vite dev-server local API for listing StepKit runs and streaming run events.
triggers:
  - dashboard server
  - Vite plugin
  - list runs
  - stream run events
  - server-sent events
---

# packages/dashboard/src/server/

Enter here when changing dashboard-local API behavior.

## Rules

- Keep APIs read-only; do not mutate run artifacts from dashboard server code.
- Preserve run-id path containment checks before streaming a run directory.
- Missing or unreadable `events.jsonl` from a not-yet-written run should produce an empty event list where current code intentionally tolerates it.
- Set SSE headers and close polling when the request closes.
