# @stepkit/core

`@stepkit/core` is the framework-neutral runtime package for StepKit, a durable, typed, observable workflow harness for coding agents.

## Install

```bash
pnpm add @stepkit/core
```

## Public role

Use this package when you need runtime primitives directly:

- `jsonSchema(schema)` and `shape({ ... })` for JSON object input/output validation.
- `runWorkflow({ workflow, input, runName, cwd })` to execute continuation workflows.
- `step(...)` and `done(...)` to model workflow progression.
- Code, command-backed agent, and interactive step execution paths.
- Prompt rendering and structured output parsing for agent steps.
- Durable run artifacts and event streams under `.stepkit/runs/<runName>/`.
- Conservative automatic retry for safe pre-dispatch failures.

Most workflow authors should start with `@stepkit/authoring`; it re-exports the common shape helpers and provides a smaller authoring surface over this runtime.

## Minimal runtime example

```ts
import { done, runWorkflow, shape, step } from "@stepkit/core";

const result = await runWorkflow({
  workflow: {
    id: "hello",
    inputShape: shape({ name: "string" }),
    outputShape: shape({ greeting: "string" }),
    start(input) {
      return step({ id: "greet" })
        .do(({ name }) => done({ greeting: `Hello, ${name}!` }))(input);
    },
  },
  input: { name: "Ada" },
  runName: "demo",
});
```

## Retry and interactive completion

Automatic retry is limited to known safe pre-dispatch failures such as provider spawn errors. Manual retry of persisted failures is a CLI concern via `stepkit retry`.

Interactive steps write protocol artifacts in their step directory and complete when `stepkit continue` produces validated output. Default interactive steps use session-file output; structured interactive steps use JSON output.

## Artifacts

Runtime events are appended to `.stepkit/runs/<runName>/events.jsonl`. Run directories are generated runtime outputs for inspection and replay; do not manually edit them to recover workflow state.
