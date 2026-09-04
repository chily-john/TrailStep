# CLI reference

The `trailstep` CLI initializes config, manages agent/provider targets, registers workflows, runs workflows, and handles continuation/retry.

## Install

```bash
npm install --global @trailstep/cli
```

Or project-local:

```bash
npm install --save-dev @trailstep/cli
npx trailstep --help
```

## Commands

```bash
trailstep
trailstep <agent-or-provider>
trailstep open [agent-or-provider]
trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]
trailstep agents
trailstep agents set <name> --provider <provider> [--model <model>] [--thinking <level>] --scope <local|project|global>
trailstep agents delete <name> --scope <local|project|global>
trailstep agents rename <old> <new> --scope <local|project|global>
trailstep add <workflow-file-bundle-or-package> [--scope <local|project|global>] [--namespace <namespace>] [--name <name>] [--workflow <workflow>] [--project-skill] [--user-skill] [--force] [--yes] [--dry-run]
trailstep remove <namespace>/<name> [--scope <local|project|global>]
trailstep workflows
trailstep <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]
trailstep continue [--interactive-file <path> | --session-file <path> | --json-file <path> | --json '<json>']
trailstep cancel [--reason '<text>']
trailstep retry <workflow-ref> <runName>
trailstep runs
trailstep doctor
trailstep update [--all | --project | --workflows | --workflow <name>] [--force] [--yes | --assume-yes]
```

## Initialize

```bash
trailstep init --scope project --install-skill
```

`trailstep init` writes TrailStep config. `--install-skill` installs the packaged TrailStep usage skill; `--no-install-skill` skips it. There is no npm postinstall prompt.

## Providers

Register a provider package or local manifest:

```bash
trailstep providers
trailstep providers pi --scope project
trailstep providers add <path-or-package>
trailstep providers add @trailstep/provider-pi --scope project
trailstep providers add ./providers/my-agent.trailstep-provider.json --scope project
trailstep providers test pi --scope project
```

`trailstep providers` shows registered provider details, prompting for scope/provider as needed. `trailstep providers <provider>` is shorthand for `trailstep providers show <provider>`.

Hook-based provider packages may execute provider package code, so they should be trusted like installed npm dependencies. Use `trailstep providers test` when you want to verify provider registration without running a full workflow.

## Agents

Open the interactive agent editor:

```bash
trailstep agents
```

Set a provider directly:

```bash
trailstep agents set default --provider pi --scope project
trailstep agents set reviewer --provider claude --model sonnet --thinking high --scope project
```

`--model` is a model override and `--thinking` is a reasoning/thinking override. Omit either one to use provider defaults.

Custom provider args can use `{{promptFile}}`, `{{outputFile}}`, `{{model}}`, and `{{thinking}}`; interactive args may also use `{{prompt}}`. Guard optional overrides with `{{#model}} ... {{/model}}` and `{{#thinking}} ... {{/thinking}}`.

## Managed agent sessions

`trailstep open [agent-or-provider]` is the canonical command for a standalone managed agent session. With no name, it opens the first configured default target, `agents.default[0]`. If no default exists, run `trailstep init` to create initial config or `trailstep agents` to add/edit agent mappings.

```bash
trailstep open
trailstep open reviewer
trailstep open claude
```

`trailstep open <name>` resolves a configured agent name first, then a registered provider with interactive support. Configured agent names win over provider shortcuts for this explicit command. `trailstep open <name>` never runs workflows; use a workflow ref when you want a workflow run.

Bare invocation keeps command and workflow precedence explicit:

- Known subcommands, such as `agents`, `add`, and `workflows`, remain subcommands.
- `trailstep <agent-or-provider>` opens an unambiguous configured agent or provider shortcut as a standalone session.
- Bare names that resolve only as workflows still run workflows.
- Bare names that resolve as both a workflow and an agent/provider fail with ambiguity guidance; use `trailstep open <name>` for the standalone session or an explicit workflow ref for the workflow.

Standalone sessions are not workflow runs or workflow steps. They write artifacts under `.trailstep/sessions/<session-id>/`, including `session.json` and `launch-prompt.md`; workflow runs continue to use `.trailstep/runs/<runName>/`. MVP limitations: only the first configured target in an agent entry is launched, the terminal backend inherits stdio, transcripts are not captured, node-pty/send-input/multi-session management is not implemented yet, and providers without hidden/system prompt injection use a recorded visible prompt fallback.

## Workflow refs

TrailStep accepts direct refs, registered refs, and bundle refs:

```bash
trailstep ./workflow.ts#reviewWorkflow --input-file input.json
trailstep ./workflows#takeItAway
trailstep project/review
trailstep global/cleanup
trailstep @acme/workflows#release
```

Direct workflow source refs may point at `.ts`, `.mts`, `.js`, or `.mjs` files, extensionless paths, directories with index candidates, or `path#exportName`. `.tsx` workflow sources are not supported yet.

## Add workflow packages

Package-backed `trailstep add` installs a versioned npm package spec or explicit GitHub package spec, discovers workflows, and stores metadata for safe remove/update decisions.

```bash
# Preview without installing, registering, or writing skills.
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --dry-run

# Install/register all workflows and generate project skills.
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes

# GitHub-sourced workflow package.
trailstep add github:acme/trailstep-workflows --scope project --workflow review --project-skill --yes
```

By default, registrations use the workflow id published by the package. Use `--name <name>` to override a single selected workflow and `--namespace <namespace>` when you need a namespace other than the scope default.

## Remove workflows

```bash
trailstep remove project/review --scope project
```

Removal deletes the registration and only uninstalls orphaned TrailStep-owned package installs. User-owned installs, still-referenced packages, and missing or stale metadata are preserved.

## Continue, cancel, and retry

Use TrailStep continuation commands rather than inventing custom resume paths:

```bash
trailstep continue
trailstep cancel --reason "Need to change requirements"
trailstep retry project/review failed-run-name
```

## Update

```bash
# Update globally installed TrailStep CLI.
trailstep update --yes

# Update TrailStep packages in the current project.
trailstep update --project --yes

# Update registered npm-backed workflow packages.
trailstep update --workflows --yes

# Update one registered workflow package target.
trailstep update --workflow project/review --yes

# Combine global CLI, project packages, and workflow packages.
trailstep update --all --yes
```

Local-file workflow refs are not package update targets. GitHub-sourced workflow package updates are not supported yet.

## Artifacts

Workflow runs write `.trailstep/runs/<runName>/` directories for inspection and replay. Standalone managed agent sessions write `.trailstep/sessions/<session-id>/` instead and are not workflow runs. Set `TRAILSTEP_RUNS_ROOT` to override the runs root for a command/session. Treat generated artifact directories as output; do not manually edit them to recover workflow state.
