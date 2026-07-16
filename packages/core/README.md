# @stepkit/core

Core runtime primitives for StepKit v0.

## What is implemented

- `jsonSchema(schema)` wraps JSON Schema validation for typed object inputs and outputs.
- `shape({ ... })` creates concise object shapes for examples and simple workflows.
- `runWorkflow({ workflow, input, runName, cwd })` interprets continuation workflows and returns a success or failure `Result`.
- `step(...)` and `done(...)` model v0 workflow progression; new workflow authors should not target the old static `steps: []` sequence.
- Code, command-backed local agent, and interactive step execution paths are exported from the package.
- Agent step prompts support literal markdown or functions of `{ input }`, rendered from live step input before command execution and structured output parsing.
- Run artifacts are written under `.stepkit/runs/<actualRunName>/`; duplicate run names receive numeric suffixes such as `<runName>-2`.
- Runtime events are incrementally appended to `.stepkit/runs/<actualRunName>/events.jsonl` as JSON lines and include workflow, step, agent-tool, and interactive-session events.
- Interactive steps spawn a command without a shell, support `{{prompt}}` and `{{promptFile}}` placeholders, and can return either opaque exit-code output or validated JSON from a declared result file.

## Minimal example

```ts
import { done, runWorkflow, shape, step } from "@stepkit/core";

const result = await runWorkflow({
  workflow: {
    id: "hello",
    inputShape: shape({ name: "string" }),
    outputShape: shape({ greeting: "string" }),
    start(input) {
      return step(
        {
          id: "greet",
          input,
          outputShape: shape({ greeting: "string" }),
          run: ({ name }) => ({ greeting: `Hello, ${name}!` }),
        },
        (output) => done(output),
      );
    },
  },
  input: { name: "Ada" },
  runName: "demo",
});
```

## Scope notes

`@stepkit/core` owns the v0 runtime and event model. `@stepkit/sdk` provides authoring helpers, and `@stepkit/cli` handles package discovery and local execution. Agent execution is provider-neutral and command-backed by local `.stepkit/config.json` mappings; optional SDK adapters are future adapter-package work, not core internals. Open runtime questions include duplicate step-id behavior, a possible maximum-step guard, event redaction policy, and config/command-template hardening.
