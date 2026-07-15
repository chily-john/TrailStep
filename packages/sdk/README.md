# @stepkit/sdk

TypeScript authoring helpers for StepKit v0 workflows.

## What is implemented

- `defineWorkflow({ id, agents, inputShape, outputShape, start })` declares a workflow as the public command/discovery unit and names provider-neutral agent roles.
- `step(...)` is the only user-facing step primitive for new workflows.
- `done(...)` marks successful workflow completion from a continuation.
- `jsonSchema`, `shape`, and shape types are re-exported from `@stepkit/core` for typed object input and output shapes.
- Agent steps reference roles with step-level `agent`; users map those roles and size tiers to command-backed local agents in `.stepkit/config.json`.
- Agent step prompts support markdown strings or functions of `{ input }` rendered from live step input.
- Legacy `defineStep({ ... })` remains as deprecated compatibility scaffolding for old object-form step tests; prefer `step(...)` for new workflows.

The static `steps: []` workflow model is no longer the v0 direction.

## Minimal workflow package export

```ts
import { defineWorkflow, done, shape, step } from "@stepkit/sdk";

export const sampleWorkflow = defineWorkflow({
  id: "sample",
  agents: {
    writer: { size: "small" },
  },
  inputShape: shape({ name: "string" }),
  outputShape: shape({ greeting: "string" }),
  start(input) {
    return step(
      {
        id: "prepare",
        input,
        outputShape: shape({ greeting: "string" }),
        agent: "writer",
        prompt: ({ input }) => `Write a concise greeting for ${input.name}.`,
      },
      (output) => done(output),
    );
  },
});
```

Published workflow packages should include the `stepkit-workflow` keyword so `stepkit list` can discover exported workflows from a consuming project. SDK adapters, including Claude SDK integration, are future optional adapter-package territory; v0 examples should stay provider-neutral by default.
