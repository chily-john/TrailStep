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
trailstep agents set <name> --provider <provider> [--model <model>] [--thinking <level>] --scope <local|project|global>
trailstep add <workflow-file-or-bundle> [--project-skill] [--user-skill]
trailstep workflows
trailstep <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]
trailstep continue
trailstep retry <workflow-ref> <runName>
trailstep runs
```

`trailstep init` writes `.trailstep/config.json` style configuration. Use `--install-skill` to install the packaged TrailStep usage skill, or `--no-install-skill` to skip skill installation without prompting. TrailStep does not use an npm postinstall prompt.

`trailstep agents` is the canonical interactive editor for provider targets. In `trailstep agents set`, `--model` is an optional model override and `--thinking` is an optional reasoning/thinking override; omit either one to use provider defaults. Interactive prompts call that choice `Use provider default`. Thinking availability is provider-aware: Pi and Claude expose TrailStep-supported levels, Codex omits `max`, and Gemini has no confirmed thinking flag wired today.

Pi model discovery is best-effort. TrailStep offers discovered Pi model choices when the local `pi` command returns them and falls back to manual entry; it does not maintain a hardcoded model catalog.

Custom provider argument templates may use `{{promptFile}}`, `{{outputFile}}`, `{{model}}`, and `{{thinking}}`; interactive templates may also use `{{prompt}}` for inline prompt input. Put optional override placeholders inside `{{#model}} ... {{/model}}` and `{{#thinking}} ... {{/thinking}}` conditional blocks so provider-default runs omit those arguments instead of passing empty values.

Workflow refs may be direct refs, registered refs, or bundle refs. Runs write `.trailstep/runs/<runName>/` directories for inspection.
