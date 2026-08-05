# @stepkit/authoring

`@stepkit/authoring` provides TypeScript helpers for writing StepKit workflows that can be run by `@stepkit/cli` or embedded with `@stepkit/core`.

## Install

```bash
pnpm add @stepkit/authoring @stepkit/core
```

## Public role

Use this package to author workflows with:

- `defineWorkflow({ start })` as the workflow definition boundary.
- `step(...)` for continuation steps.
- `done(...)` for successful completion.
- Workflow-level `agents` declarations for provider-neutral roles.
- Step-level `agent` selection for agent-backed steps.
- `shape`, `jsonSchema`, and `promptTemplate` helpers re-exported from `@stepkit/core`.

Workflow inputs and outputs should be JSON objects validated by a shape or JSON Schema.

## Example

```ts
import { defineWorkflow, done, shape, step } from "@stepkit/authoring";

export const sampleWorkflow = defineWorkflow({
  id: "sample",
  agents: {
    writer: { size: "small" },
  },
  inputShape: shape({ name: "string" }),
  outputShape: shape({ greeting: "string" }),
  start(input) {
    return step({ id: "prepare" })
      .prompt(({ input }) => `Write a concise greeting for ${input.name}.`, {
        output: shape({ greeting: "string" }),
        agent: "writer",
      })
      .do((output) => done(output))(input);
  },
});
```

Export workflows from a Node-readable module. Consumers can run direct refs such as `./workflows/sample.ts#sampleWorkflow`, register refs with `stepkit add`, or use bundle refs when a package exposes a StepKit workflow manifest.
