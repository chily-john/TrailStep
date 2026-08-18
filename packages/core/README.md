# @trailstep/core

`@trailstep/core` is the framework-neutral runtime package for TrailStep.

## Install

```bash
npm install @trailstep/core
```

Use the equivalent command for your package manager if you use `pnpm`, `yarn`, or `bun`.

## Public role

Use this package for low-level TrailStep runtime integration: JSON object input/output validation, `runWorkflow`, continuation runtime primitives, events, retry state, provider contracts, and local run artifact handling.

Most workflow authors should start with `@trailstep/authoring`, which re-exports the common authoring helpers from core and adds `defineWorkflow(...)`.

Runtime events are appended to `.trailstep/runs/<runName>/events.jsonl` by default. Set `TRAILSTEP_RUNS_ROOT` in CLI runs when you need artifacts somewhere else. Run directories are generated outputs for inspection and replay; do not manually edit them to recover workflow state.
