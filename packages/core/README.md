# @stepkit/core

Core runtime primitives for StepKit workflows.

## What is implemented

- `jsonSchema(schema)` wraps JSON Schema validation for typed object inputs and outputs.
- `shape({ ... })` creates concise object shapes for examples and simple workflows.
- `runWorkflow({ workflow, input, runName, cwd })` interprets continuation workflows and returns a success or failure `Result`.
- `step(...)` and `done(...)` model workflow progression through a continuation chain returned from `workflow.start`.
- Code, command-backed local agent, and interactive step execution paths are exported from the package.
- Agent step prompts support literal markdown, functions of `{ input }`, or `promptTemplate(...)` local files rendered before command execution and structured output parsing.
- Run artifacts are written under `.stepkit/runs/<actualRunName>/`; duplicate run names receive numeric suffixes such as `<runName>-2`.
- Runtime events are incrementally appended to `.stepkit/runs/<actualRunName>/events.jsonl` as JSON lines and include workflow, step, agent-tool, and interactive-session events.
- Interactive steps spawn a command without a shell, support `{{prompt}}` and `{{promptFile}}` placeholders, and return opaque exit-code output.

## Minimal example

```ts
import { done, runWorkflow, shape, step } from "@stepkit/core";

const result = await runWorkflow({
  workflow: {
    id: "hello",
    inputShape: shape({ name: "string" }),
    outputShape: shape({ greeting: "string" }),
    start(input) {
      return step({ id: "greet" })
        .next(({ name }) => done({ greeting: `Hello, ${name}!` }))(input);
    },
  },
  input: { name: "Ada" },
  runName: "demo",
});
```

## Scope notes

`@stepkit/core` owns the runtime and event model. `@stepkit/sdk` provides authoring helpers, and `@stepkit/cli` handles package discovery and local execution. Agent execution is provider-neutral and command-backed by local `.stepkit/config.json` mappings.
