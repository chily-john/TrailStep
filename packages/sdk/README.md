# @stepkit/sdk

TypeScript authoring helpers for StepKit workflows.

## What is implemented

- `defineWorkflow({ id, agents, inputShape, outputShape, start })` declares a workflow as the public command/discovery unit and names provider-neutral agent roles.
- `step(...)` is the user-facing step primitive for new workflows.
- `done(...)` marks successful workflow completion from a continuation.
- `jsonSchema`, `shape`, `promptTemplate`, and shape types are re-exported from `@stepkit/core`.
- Agent steps reference roles with step-level `agent`; users map those roles and size tiers to command-backed local agents in `.stepkit/config.json`.
- Agent step prompts support markdown strings or functions of `{ input }` rendered from live step input.

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
    return step({
      id: "prepare",
    })
      .prompt(({ input }) => `Write a concise greeting for ${input.name}.`, {
        output: shape({ greeting: "string" }),
        agent: "writer",
      })
      .do((output) => done(output))(input);
  },
});
```

Published workflow packages should include the `stepkit-workflow` keyword so `stepkit workflows` can discover exported workflows from a consuming project.
