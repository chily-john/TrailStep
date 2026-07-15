# @stepkit/cli

Command-line discovery and local execution for StepKit v0 workflows.

## Commands

```bash
stepkit list
stepkit <package:workflowExport> <workflowRunName> [--input '<json>' | --input-file <path>]
```

## Discovery

`stepkit list` reads the current project's direct dependencies and dev dependencies, resolves packages whose `package.json` contains the `stepkit-workflow` keyword, imports their module entry point, and prints exported workflow objects as package-qualified ids:

```text
@acme/workflows:releaseWorkflow
```

Workflows, not individual steps, are the public command and discovery units. The CLI executes exported `defineWorkflow({ ... start })` registrations; it does not expose a static step-list authoring model as a user-facing command surface.

## Execution

`stepkit <package:workflowExport> <workflowRunName>` loads JSON object input from `--input`, from `--input-file`, or defaults to `{}`. It then runs the discovered workflow through `@stepkit/core` from the consuming project's working directory. For agent steps, local `.stepkit/config.json` maps workflow roles and size tiers to command-backed local agents.

At runtime, the workflow `start(input)` function returns a `step(...)` node. Each step continuation returns another `step(...)` node or `done(...)`; output shapes are validated before continuations and final workflow completion.

Run artifacts are written to:

```text
.stepkit/runs/<actualRunName>/
```

If the requested run name already exists, the runtime creates a suffixed directory such as `<workflowRunName>-2`. Event artifacts are persisted as `events.jsonl` in the run directory.

Interactive steps are executed by the core runtime. Their command templates run without a shell, inherit stdio, and may use `{{prompt}}` or `{{promptFile}}` placeholders declared by the workflow author or local `interactiveAgents` config. Working agents are separate from interactive agents and write structured JSON output for validation.
