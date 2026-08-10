---
kind: rules
paths:
  - packages/dashboard/
summary: `@stepkit/dashboard` Svelte/Vite local workflow run observability UI.
triggers:
  - '@stepkit/dashboard'
  - dashboard package
  - Svelte
  - Vite
  - observability UI
  - telemetry
---

# packages/dashboard/

Enter here for UI work around workflow run inspection, event visualization, prompt/state observability, or dashboard build tooling. The package displays read-only local workflow runs and events from `.stepkit/runs`.

## Areas

- `src/`: Enter when changing Svelte app code, local run/event API helpers, event stream behavior, mount behavior, or dashboard tests.
- `index.html`: Enter when changing the Vite app shell or mount target.
- `vite.config.ts` / `svelte.config.js`: Enter when changing dashboard build, test, local API plugin, or Svelte preprocessing behavior.
- `package.json`: Enter when dashboard scripts, dependencies, metadata, or publish files change.
- `README.md`: Enter when publish-facing dashboard usage changes.

## Rules

- Keep the dashboard read-only against local `.stepkit/runs` artifacts.
- Preserve the `#app` mount target unless `src/main.ts` changes with it.
- Keep observability decisions aligned with core's runtime event-log behavior and redaction decisions.
