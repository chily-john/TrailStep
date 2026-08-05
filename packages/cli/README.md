# @stepkit/cli

`@stepkit/cli` provides the `stepkit` command for initializing projects, configuring agents, registering workflows, running workflows, continuing interactive steps, and retrying failed runs.

## Install

```bash
pnpm add -D @stepkit/cli
```

## Commands

```bash
stepkit add <workflow-file-or-bundle> [--scope <local|project|global>] [--namespace <namespace>] [--name <name>] [--workflow <workflow>] [--project-skill] [--user-skill] [--force]
stepkit remove <namespace>/<name> [--scope <local|project|global>]
stepkit init [--scope <local|project|global>] [--install-skill | --no-install-skill]
stepkit agents
stepkit agents set <name> --provider <provider> --model <model> [--thinking <none|low|medium|high|xhigh|max>] --scope <local|project|global>
stepkit agents delete <name> --scope <local|project|global>
stepkit agents rename <old> <new> --scope <local|project|global>
stepkit workflows
stepkit continue
stepkit continue --interactive-file <path>
stepkit continue --session-file <path>
stepkit continue --json-file <path>
stepkit continue --json '<json>'
stepkit cancel [--reason '<text>']
stepkit doctor
stepkit update [--all | --workflows | --workflow <name>] [--force] [--assume-yes]
stepkit <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]
stepkit retry <workflow-ref> <runName>
stepkit runs
```

## Init and agent setup

`stepkit init` creates StepKit configuration at the chosen scope and prompts when scope or agent details are omitted. Use `--install-skill` to install the packaged StepKit usage skill during init, or `--no-install-skill` to skip skill installation without prompting. StepKit does not use an npm postinstall prompt.

Use `stepkit agents` or the `stepkit agents set/delete/rename` commands to manage provider targets. Workflows declare role names; configuration maps those roles to providers such as `claude`, `codex`, `pi`, `gemini`, or custom command-backed providers.

## Workflow refs

Run workflows by direct ref, registered ref, or bundle ref:

```bash
stepkit ./workflow.ts#reviewWorkflow      # direct local TypeScript file export
stepkit ./workflows#takeItAway            # direct source directory export
stepkit ./workflow.mjs                    # direct local workflow file
stepkit project/review                    # registered project workflow
stepkit global/cleanup                    # registered global workflow
stepkit @acme/workflows#release           # bundle manifest workflow
stepkit @acme/workflows:releaseWorkflow   # legacy package export compatibility
```

`workflowRunName` is optional when starting a run. JSON input comes from `--input`, `--input-file`, or defaults to `{}`; supplied input must be a JSON object.

## Registration and generated workflow skills

`stepkit add` writes registry entries without installing packages. When omitted, scope prompts interactively; namespace defaults to `project` for project/local scope and `global` for global scope; name defaults to the workflow id.

For package bundles with multiple workflows, `--workflow` accepts one workflow, a comma-separated list such as `--workflow review,release,cleanup`, or `--workflow '*'` for every workflow. `--project-skill` and `--user-skill` can generate agent skill wrappers that invoke registered workflows with JSON object input.

## Interactive completion and retry

Interactive steps complete through `stepkit continue`. Use `stepkit continue --session-file session-description.md` for default interactive steps, or `stepkit continue --json-file output.json` / `stepkit continue --json '{"ok":true}'` for structured output.

Use `stepkit retry <workflow-ref> <runName>` for manual retry from the latest unresolved failure in an existing run artifact. Workflow-level resume flags are intentionally unsupported; use retry instead of inventing a separate resume mechanism.

## Artifacts

Runs write `.stepkit/runs/<runName>/` directories and `events.jsonl` files in the consuming project. These are generated runtime outputs for inspection and should not be manually edited to change workflow state.
