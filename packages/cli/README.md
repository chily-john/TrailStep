# @stepkit/cli

Command-line discovery and local execution for StepKit workflows.

## Commands

```bash
stepkit list
stepkit skill-check
stepkit <package:workflowExport> <workflowRunName> [--input '<json>' | --input-file <path> | --resume]
```

## Discovery

`stepkit list` reads the current project's direct dependencies and dev dependencies, resolves packages whose `package.json` contains the `stepkit-workflow` keyword, imports their module entry point, and prints exported workflow objects as package-qualified ids:

```text
@acme/workflows:releaseWorkflow
```

Workflows, not individual steps, are the public command and discovery units.

## Execution

`stepkit <package:workflowExport> <workflowRunName>` loads JSON object input from `--input`, from `--input-file`, or defaults to `{}`. With `--resume`, the run name identifies an existing `.stepkit/runs/<workflowRunName>` directory. The CLI runs the discovered workflow through `@stepkit/core` from the consuming project's working directory.

For agent steps, local `.stepkit/config.json` maps workflow roles and size tiers to command-backed local agents. Interactive steps are executed by the core runtime. Their command templates run without a shell, inherit stdio, and may use `{{prompt}}` or `{{promptFile}}` placeholders declared by local `interactiveAgents` config. Working agents are separate from interactive agents and write structured JSON output for validation.

Run artifacts are written to:

```text
.stepkit/runs/<actualRunName>/
```

If the requested run name already exists, the runtime creates a suffixed directory such as `<workflowRunName>-2`. Event artifacts are persisted as `events.jsonl` in the run directory.
