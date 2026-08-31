# @trailstep/core

`@trailstep/core` is the framework-neutral runtime package for TrailStep.

Most workflow authors should start with [`@trailstep/authoring`](../authoring/README.md), which re-exports common authoring helpers and adds `defineWorkflow(...)`.

## Install

```bash
npm install @trailstep/core
```

Use the equivalent command for your package manager if you use `pnpm`, `yarn`, or `bun`.

## Public role

Use this package for low-level TrailStep runtime integration:

- JSON-object input/output validation
- continuation runtime primitives
- `runWorkflow`
- workflow events
- retry state
- provider contracts
- local run artifact handling

TrailStep's key runtime boundary is the step: each step can run as a focused unit of work, receive structured output, persist events, and return the next continuation.

Runtime events are appended to `.trailstep/runs/<runName>/events.jsonl` by default. Set `TRAILSTEP_RUNS_ROOT` in CLI runs when you need artifacts somewhere else. Run directories are generated outputs for inspection and replay; do not manually edit them to recover workflow state.

## Provider package export convention

Provider packages expose their definition from the package root as an ESM export named `trailstepProvider`. The exported object must include a serializable `manifest`; optional hook functions belong beside the manifest, not inside it:

```ts
export const trailstepProvider = {
  manifest: { schemaVersion: 1, id: "example", /* ... */ },
  hooks: { /* optional hook functions */ },
};
```

## More docs

- [Architecture](../../docs/architecture.md)
- [Authoring workflows](../../docs/authoring-workflows.md)
- [CLI reference](../../docs/cli-reference.md)
