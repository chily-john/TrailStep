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
- Interactive steps spawn a command without a shell, support `{{prompt}}` and `{{promptFile}}` placeholders, and complete when `stepkit continue` writes validated output artifacts.

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

## Interactive step artifacts

Interactive steps write ordered artifacts under `.stepkit/runs/<actualRunName>/steps/<ordinal>-<stepId>/`. The runtime creates `interactive.json` and expects `stepkit continue` to produce `output.json` that matches the step output schema. Default interactive steps use session-file mode: the prompt asks for a dense `session-description.md`, and the validated output shape is `{ "sessionFile": "steps/<ordinal>-<stepId>/session-description.md" }`. Custom structured interactive steps use JSON mode and validate the submitted object directly.

`prompt.txt` is written only when a custom interactive command uses the `{{promptFile}}` placeholder; direct `{{prompt}}` commands and built-in providers receive the same preambled prompt without a prompt artifact. Working-agent step directories remain separate and minimal: `prompt.md`, `output.json`, and optional `usage.json`.

If an interactive process exits before `stepkit continue` marks `interactive.json` as completed, the step fails instead of returning an opaque `{ exitCode }` result. When completion wins the race, StepKit best-effort aborts the interactive subprocess; this is not a guarantee of provider-specific graceful shutdown or transcript capture.

## Scope notes

`@stepkit/core` owns the runtime and event model. `@stepkit/sdk` provides authoring helpers, and `@stepkit/cli` handles package discovery and local execution. Agent execution is provider-neutral and command-backed by local `.stepkit/config.json` mappings.
