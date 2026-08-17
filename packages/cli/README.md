# @trailstep/cli

`@trailstep/cli` provides the `trailstep` command for initializing projects, configuring agents, registering workflows, running workflows, continuing interactive steps, retrying failed runs, and managing package-backed workflow registrations.

## Install

```bash
pnpm add -D @trailstep/cli
```

## Commands

```bash
trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]
trailstep agents
trailstep agents set <name> --provider <provider> [--model <model>] [--thinking <level>] --scope <local|project|global>
trailstep add <workflow-file-bundle-or-package> [--scope <local|project|global>] [--workflow <workflow>] [--project-skill] [--user-skill] [--force] [--yes] [--dry-run]
trailstep remove <namespace>/<name> [--scope <local|project|global>]
trailstep workflows
trailstep update [--all | --project | --workflows | --workflow <name>] [--force] [--yes | --assume-yes]
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

## Package-backed workflow lifecycle

Package-backed `trailstep add` installs a versioned npm package spec (for example, `@acme/workflows@latest`) or explicit GitHub package spec, discovers workflows from that package, and stores package metadata with each registration so remove/update can make safe decisions later.

```bash
# Plan a package-backed add without installing, registering, or writing skills.
trailstep add @acme/trailstep-workflows@latest --scope project --workflow '*' --dry-run

# Install an npm-backed workflow package into the project root and register all workflows.
trailstep add @acme/trailstep-workflows@latest --scope project --workflow '*' --yes

# Install a GitHub-sourced workflow package into the global package root.
trailstep add github:acme/trailstep-workflows --scope global --workflow review --yes
```

Install roots are scope-aware: `local` and `project` package installs use the command cwd and `--save-dev`; `global` package installs use `~/.trailstep/packages` and `--save`. Project and global roots are updated independently.

Removing a registration first deletes the config entry, then attempts package cleanup only when the removed entry has matching package metadata, no remaining registration references the same package install, and the install is TrailStep-owned.

```bash
trailstep remove project/review --scope project
```

Cleanup outcomes are intentionally conservative:

- orphaned TrailStep-owned installs are uninstalled;
- installs still referenced by other registrations are preserved;
- user-owned installs are preserved;
- missing or stale package metadata is preserved rather than guessed;
- if uninstall fails, the registration remains removed and the command reports the install root for manual cleanup.

Update the globally installed TrailStep CLI binary:

```bash
trailstep update --yes
```

Bare `trailstep update` updates only the global CLI installation. It does not mutate project `@trailstep/core` or `@trailstep/authoring` dependencies, so authoring/runtime upgrades stay under explicit user control.

Update project TrailStep packages or workflow packages from registered metadata:

```bash
# Update TrailStep packages in this project's package.json.
trailstep update --project --yes

# Update all registered npm-backed workflow packages across their install roots.
trailstep update --workflows --yes

# Update one registered workflow package target. Use namespace/name when a bare name is ambiguous.
trailstep update --workflow project/review --yes

# Update global CLI, TrailStep packages in the current project, and workflow packages in all roots.
trailstep update --all --yes
```

`trailstep update` prompts before running global installs, rewriting manifests, or running package-manager install commands unless `--yes` or `--assume-yes` is provided. `--force` only bypasses blocking deprecation preflight findings; it does not skip confirmation. After updating the global CLI, TrailStep automatically refreshes tracked installs of the packaged TrailStep usage skill when possible.

Safety boundaries for workflow package updates:

- local-file workflow refs are not package update targets;
- missing or stale package metadata is skipped or rejected before any package.json mutation;
- GitHub-sourced workflow package updates are not supported yet and are skipped with a message;
- updates rewrite only affected package names in each install root and run one package-manager install per mutated root;
- no-op targets do not rewrite manifests or run install commands.
