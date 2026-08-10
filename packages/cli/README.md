# @trailstep/cli

`@trailstep/cli` provides the `trailstep` command for initializing projects, configuring agents, registering workflows, running workflows, continuing interactive steps, and retrying failed runs.

## Install

```bash
pnpm add -D @trailstep/cli
```

## Commands

```bash
trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]
trailstep agents
trailstep add <workflow-file-or-bundle> [--project-skill] [--user-skill]
trailstep workflows
trailstep <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]
trailstep continue
trailstep retry <workflow-ref> <runName>
trailstep runs
```

`trailstep init` writes `.trailstep/config.json` style configuration. Use `--install-skill` to install the packaged TrailStep usage skill, or `--no-install-skill` to skip skill installation without prompting. TrailStep does not use an npm postinstall prompt.

Workflow refs may be direct refs, registered refs, or bundle refs. Runs write `.trailstep/runs/<runName>/` directories for inspection.
