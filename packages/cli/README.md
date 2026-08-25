# @trailstep/cli

`@trailstep/cli` provides the `trailstep` command for initializing TrailStep config, configuring agent providers, registering workflows, running workflows, continuing interactive steps, retrying failed runs, and managing package-backed workflow registrations.

## Install

Install globally if you want a `trailstep` command everywhere:

```bash
npm install --global @trailstep/cli
```

Or keep it project-local:

```bash
npm install --save-dev @trailstep/cli
npx trailstep --help
```

Use the equivalent command for your package manager if you use `pnpm`, `yarn`, or `bun`.

## Quick start

Prerequisite: install a CLI coding agent. TrailStep has been tested most heavily with Pi and Claude Code, so they currently have the best support.

```bash
trailstep init
trailstep add @trailstep/create-flows@latest
trailstep workflows
trailstep project/grill-it-away
```

Use the interactive prompts to choose project scope, configure your agent/provider, install the TrailStep usage skill, select workflows, and generate project skills. Generated skills let supported coding agents discover and invoke workflows from the agent UI.

<details>
<summary>Scriptable setup</summary>

```bash
trailstep init --scope project --install-skill
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes
trailstep workflows
```

</details>

## Common commands

```bash
trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]
trailstep agents
trailstep add <workflow-file-bundle-or-package> [--scope <local|project|global>] [--workflow <workflow>] [--project-skill] [--user-skill] [--yes] [--dry-run]
trailstep workflows
trailstep <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]
trailstep continue
trailstep retry <workflow-ref> <runName>
trailstep update [--all | --project | --workflows | --workflow <name>] [--yes]
```

See the repository [CLI reference](../../docs/cli-reference.md) for the full command list and detailed behavior.

## Workflow refs

TrailStep accepts these workflow reference forms:

```bash
trailstep ./workflow.ts#reviewWorkflow --input-file input.json
trailstep project/review
trailstep global/cleanup
trailstep @acme/workflows#release
```

Use direct refs while developing, registered refs for stable project/user workflows, and bundle refs for workflows exposed by installed packages.

## Package-backed workflows

`trailstep add` can install and register workflows from npm packages or explicit GitHub specs:

```bash
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --dry-run
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes
trailstep add github:acme/trailstep-workflows --scope project --workflow review --project-skill --yes
```

TrailStep detects the target package manager from lockfiles or the `packageManager` field and defaults to `npm` only when neither is present.

## Scopes

- `local`: private to this checkout/machine.
- `project`: shared project config; recommended for team workflows.
- `global`: user-wide config and personal workflows.

See [Scopes and config](../../docs/scopes-and-config.md) for details.

## Run artifacts

Runs write `.trailstep/runs/<runName>/` directories for inspection and replay. Set `TRAILSTEP_RUNS_ROOT` to override the runs root for a command/session. Treat run directories as generated output; do not manually edit them to recover workflow state.
