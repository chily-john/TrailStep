# Getting started with TrailStep

TrailStep is a workflow layer for CLI coding agents. It does not replace your agent; it gives that agent durable, typed workflows to run.

## Prerequisites

- Node 24 or newer.
- A JavaScript package manager (`npm`, `pnpm`, `yarn`, or `bun`).
- A CLI coding agent installed and available from your terminal.

TrailStep has been tested most heavily with Pi and Claude Code, so they currently have the best support. More provider support will continue to improve.

## Install the CLI

Install globally if you want `trailstep` available everywhere:

```bash
npm install --global @trailstep/cli
trailstep --help
```

Or keep it project-local:

```bash
npm install --save-dev @trailstep/cli
npx trailstep --help
```

Use the equivalent command for your package manager if you use `pnpm`, `yarn`, or `bun`.

## Initialize a project

For a team/project setup, start with project scope:

```bash
trailstep init --scope project --install-skill
```

`trailstep init` writes TrailStep config and walks you through agent/provider defaults. `--install-skill` installs the packaged TrailStep usage skill so supported agents know how to author, register, run, continue, and retry workflows.

Use `trailstep agents` any time you want to edit provider targets interactively:

```bash
trailstep agents
```

Or set a default agent directly:

```bash
trailstep agents set default --provider pi --scope project
trailstep agents set default --provider claude --scope project
```

## Add ready-made workflows

Install/register all workflows from `@trailstep/create-flows` and generate project skills for them:

```bash
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes
```

That package currently provides:

- `project/grill-it-away` — interactive clarification first, then implementation workflow.
- `project/take-it-away` — starts from an existing conversation or feature request.

TrailStep can also add workflows from GitHub package specs or local files:

```bash
trailstep add github:acme/trailstep-workflows --scope project --workflow review --project-skill
trailstep add ./workflows/review.ts#review --scope project --name review --project-skill
```

Use `--dry-run` before package-backed adds to preview the plan without installing, registering, or writing skills:

```bash
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --dry-run
```

## Run workflows from your agent

When you add a workflow with `--project-skill` or `--user-skill`, TrailStep writes a generated skill that explains how to call the registered workflow. In agents that expose skills as slash commands, this lets you invoke workflows from the agent UI instead of manually typing CLI commands.

Use project skills for team-shared workflows and user skills for personal workflows:

```bash
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes
trailstep add @trailstep/create-flows@latest --scope global --workflow "*" --user-skill --yes
```

## Direct CLI usage

You can always run workflows directly:

```bash
trailstep workflows
trailstep project/grill-it-away
trailstep project/take-it-away --input-file feature-request.json
trailstep ./workflows/review.ts#review --input '{"topic":"release notes"}'
```

Workflow refs may be:

- direct refs: `./workflows/review.ts#review`
- registered refs: `project/review`
- bundle refs: `@acme/workflows#review`

Use `trailstep continue` for waiting/interrupted interactive work and `trailstep retry <workflow-ref> <runName>` for failed-run replay.

## Next steps

- Learn the authoring model in [Authoring workflows](authoring-workflows.md).
- Learn generated skill behavior in [Generated skills](generated-skills.md).
- Learn scope selection in [Scopes and config](scopes-and-config.md).
- See all commands in [CLI reference](cli-reference.md).
