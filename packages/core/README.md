# @trailstep/core

`@trailstep/core` is the framework-neutral runtime package for TrailStep.

## Install

```bash
pnpm add @trailstep/core
```

## Public role

Use this package for JSON object input/output validation, `runWorkflow`, continuation runtime primitives, events, retry state, and local run artifact handling.

Runtime events are appended to `.trailstep/runs/<runName>/events.jsonl`. Run directories are generated outputs for inspection and replay; do not manually edit them to recover workflow state.
