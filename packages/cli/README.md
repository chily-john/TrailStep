# @stepkit/cli

Command-line discovery, registration, and local execution for StepKit workflows.

## Commands

```bash
stepkit add <workflow-file-or-bundle> --scope <project|user> --namespace <namespace> --name <name> [--workflow <workflow>] [--force]
stepkit list
stepkit <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]
stepkit <workflow-ref> <workflowRunName> --resume
```

Workflow refs include:

```bash
stepkit ./workflows/review.mjs
stepkit ./workflows/review.mjs run-one
stepkit project/review
stepkit user/cleanup
stepkit @acme/workflows#release
```

## Workflow refs

- Direct local files use a relative or absolute path such as `./workflows/review.mjs`. Direct files must be native Node-loadable ESM today; `.mjs` is supported, while direct `.ts` and `.tsx` files are rejected until StepKit chooses a TypeScript loader policy.
- Registered refs such as `project/review`, `user/cleanup`, or unqualified `review` resolve through string entries under `.stepkit/config.json` or `~/.stepkit/config.json` `workflows`. Project entries take precedence for unqualified names.
- Bundle refs use `#`, for example `@acme/workflows#release`. The package must expose `stepkit.workflows` manifest metadata mapping workflow names to module exports.
- Legacy `package:export` refs remain supported for compatibility with package export discovery.

`workflowRunName` is optional when starting a run. If it is omitted, StepKit generates a readable run name from the workflow ref, timestamp, and short suffix. Resume requires an explicit run name so the CLI can locate `.stepkit/runs/<workflowRunName>`:

```bash
stepkit ./workflows/review.mjs
stepkit ./workflows/review.mjs run-one
stepkit ./workflows/review.mjs run-one --resume
```

## Registration

`stepkit add` writes workflow registry entries without installing packages. Register local files or already-installed bundle packages, choose a scope and namespace, and use the resulting ref in later runs:

```bash
stepkit add ./workflows/review.mjs --scope project --namespace project --name review
stepkit project/review
```

## Discovery and list

`stepkit list` is legacy package discovery only. It reads the current project's direct dependencies and dev dependencies, resolves packages whose `package.json` contains the `stepkit-workflow` keyword, imports their module entry point, and prints exported workflow objects as package-qualified ids:

```text
@acme/workflows:releaseWorkflow
```

Registered refs and bundle manifest refs can be run directly, but they are not included in `stepkit list` output yet. Workflows, not individual steps, are the public command and discovery units.

## Execution

`stepkit <workflow-ref> [workflowRunName]` loads JSON object input from `--input`, from `--input-file`, or defaults to `{}`. The CLI runs the resolved workflow through `@stepkit/core` from the consuming project's working directory.

For agent steps, local `.stepkit/config.json` maps workflow roles and size tiers to command-backed local agents. Interactive steps are executed by the core runtime. Their command templates run without a shell, inherit stdio, and may use `{{prompt}}` or `{{promptFile}}` placeholders declared by local `interactiveAgents` config. Working agents are separate from interactive agents and write structured JSON output for validation.

Run artifacts are written to:

```text
.stepkit/runs/<actualRunName>/
```

If the requested run name already exists, the runtime creates a suffixed directory such as `<workflowRunName>-2`. Event artifacts are persisted as `events.jsonl` in the run directory.
