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

For a team/project setup, start the interactive setup from your project root:

```bash
trailstep init
```

Choose **project** scope for team-shared config, pick the agent/provider you want TrailStep to use, and say yes when asked to install the packaged TrailStep usage skill. That skill teaches supported agents how to author, register, run, continue, and retry workflows.

<details>
<summary>Scriptable init</summary>

Use flags for CI, bootstrap scripts, or terminals where prompts are unavailable:

```bash
trailstep init --scope project --install-skill
```

</details>

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

Install/register reusable workflows from `@trailstep/create-flows` through the interactive TUI:

```bash
trailstep add @trailstep/create-flows@latest
```

Choose **project** scope, select the workflows you want (or **Select all**), and add project skills when prompted.

That package currently provides:

- `project/grill-it-away` — interactive clarification first, then implementation workflow.
- `project/take-it-away` — starts from an existing conversation or feature request.

TrailStep can also add workflows from GitHub package specs or local files:

```bash
trailstep add github:acme/trailstep-workflows --scope project --workflow review --project-skill
trailstep add ./workflows/review.ts#review --scope project --name review --project-skill
```

<details>
<summary>Scriptable add</summary>

Use `--dry-run` before package-backed adds to preview the plan without installing, registering, or writing skills:

```bash
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --dry-run
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes
```

</details>

## Run workflows from your agent

When you add a workflow with `--project-skill` or `--user-skill`, TrailStep writes a generated skill that explains how to call the registered workflow. In agents that expose skills as slash commands, this lets you invoke workflows from the agent UI instead of manually typing CLI commands.

Use project skills for team-shared workflows and user skills for personal workflows. The interactive `trailstep add` flow asks which skill targets to create; for automated setup, pass `--project-skill` or `--user-skill` explicitly.

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
