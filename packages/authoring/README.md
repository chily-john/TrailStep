# @trailstep/authoring

`@trailstep/authoring` provides TypeScript helpers for writing TrailStep workflows.

## Install

```bash
pnpm add @trailstep/authoring
```

## Public role

Use this package to author workflows with:

- `defineWorkflow({ start })` as the workflow definition boundary.
- `step(...)` for continuation steps.
- `done(...)` for successful completion.

Export workflows from a Node-readable module. Consumers can run direct refs such as `./workflows/sample.ts#sampleWorkflow`, register refs with `trailstep add`, or use bundle refs when a package exposes a TrailStep workflow manifest.
