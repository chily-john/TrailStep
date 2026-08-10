---
kind: rules
paths:
  - packages/dashboard/src/
summary: Svelte source, local run/event API helpers, and tests for the dashboard.
triggers:
  - dashboard source
  - Svelte component
  - dashboard tests
  - local run events
  - app mount
---

# packages/dashboard/src/

Enter here when implementing dashboard UI behavior or changing local run/event loading.

## Subdirectories

- `events/`: Enter when changing browser-side run loading, event stream connection, or event row reduction.
- `server/`: Enter when changing the Vite local API, run discovery, or server-sent event streaming.

## Files

- `App.svelte`: Change when the visible dashboard run selector or event stream layout changes.
- `main.ts`: Change when Svelte app mounting behavior changes; it expects `#app` in `index.html`.
- `App.test.ts`: Change when dashboard behavior expectations change.
- `vite-env.d.ts`: Change only when Vite/Svelte ambient type needs change.

## Rules

- Keep user-facing dashboard heading and intro copy synchronized between app code, exported copy constants, and tests.
- Use the Vite dev-server API only for local read-only `.stepkit/runs` inspection.
- Prefer accessible labels and headings for inspection surfaces.
