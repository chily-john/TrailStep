---
"@trailstep/core": patch
"@trailstep/cli": patch
---

Break the import cycles in the authoring, provider-catalog and CLI registry
layers.

`@trailstep/core` now keeps mutually recursive type declarations in a single
leaf module each — the agent step request config moved next to the agent
adapter contract (`contracts/agents/agent-adapter.types.ts`), the workflow
invocation node moved next to the `Workflow` contract
(`authoring/workflow/workflow.types.ts`), and the durable run `Event` and the
interactive process contract moved into `contracts/events/event.types.ts` and
`contracts/process/interactive-process.types.ts`. `@trailstep/cli` extracts the
shared registry vocabulary into
`internals/workflow-registry/workflow-registry.types.ts` and the path-shaped
reference check into `internals/workflow-reference/direct-file-reference.ts`,
so the workflow registry and workflow resolution modules no longer import each
other. This is a behavior-preserving refactor: the public API of both packages
is unchanged and no runtime behavior changed.
