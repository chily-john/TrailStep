---
kind: rules
paths:
  - packages/cli/
summary: `@trailstep/cli` package for workflow discovery, workflow package installation, workflow registration, workflow skill distribution, skill checks, doctor deprecation scanning, update command self-update planning and target-version deprecation preflight, agent/config initialization/loading, interactive continuation/cancellation, run listing, JSON input loading, retry, and local workflow execution.
triggers:
  - '@trailstep/cli'
  - CLI package
  - agent config
  - command
  - workflow discovery
  - local execution
---

# packages/cli/

Enter here for user-facing command behavior, executable packaging, workflow package discovery/installation, workflow package skill checks, or local run orchestration. The CLI is intentionally a thin shell around discovery/config/input loading and `@trailstep/core` execution.

## Areas

- `src/`: Enter when changing the CLI entrypoint, command registry, command parsing/output, discovery, agent-config initialization/helpers, workflow package installation, workflow registration, workflow skill distribution, skill checks, doctor deprecation scanning, update command self-update planning/target-version deprecation preflight, interactive continuation/cancellation, run listing, config loading, input loading, retry handling, or tests.
- `package.json`: Enter when `bin`, exports, package metadata, dependencies, or build scripts for `@trailstep/cli` change.
- `README.md`: Enter when publish-facing command usage guidance changes.

## Rules

- `trailstep workflows` prints registered workflows (from `.trailstep/config.json`, `.trailstep/config-local.json`, and `~/.trailstep/config.json`) grouped by scope heading — local, project (shared), global — followed by direct dependencies/devDependencies marked with the `trailstep-workflow` keyword, then prompts to select one and drill into a detail page (target ref, description, and a menu to edit namespace/name, remove, go back, or exit) that renames its namespace/name in place or removes it after confirmation.
- `trailstep skill-check` reports discovered workflow packages that do not contain `SKILL.md`.
- `trailstep doctor` scans registered workflow sources and discoverable workflow packages for TrailStep deprecation manifest findings using installed `@trailstep/core`/`@trailstep/authoring` manifest versions; it matches non-aliased named imports in readable sources, returns exit code `2` for blocking findings or `1` for warnings, and skips unreadable targets.
- `trailstep update` parses optional scope flags (`--all`, `--project`, `--workflows`, or `--workflow <name>`), `--force`, and `--yes`/`--assume-yes`; the default global CLI scope queries npm metadata for `@trailstep/cli`, confirms, runs a global package-manager install for the current binary's inferred package manager, then refreshes tracked packaged TrailStep usage skill installs when possible, all without mutating project authoring/runtime dependencies. `--project` reads current TrailStep package ranges, exits no-op when none are present, otherwise scans affected workflow sources for TrailStep deprecations using target TrailStep package versions, confirms, rewrites `package.json`, and runs install. Workflow scopes resolve only registered npm package targets with package metadata, require install-root dependency entries, query latest stable npm metadata from each install root, scan all bundle sources, skip keyword-discovered packages, and skip local-file refs, GitHub refs, stale metadata, or missing package metadata.
- Workflow runs execute resolved direct files, registered refs, bundle manifest refs, or legacy package export refs through `@trailstep/core` from the consuming project's cwd; direct source refs support `.ts`, `.mts`, `.js`, `.mjs`, extensionless paths, directories with index candidates, and `path#exportName`, but not `.tsx`.
- Global, project, and local config can contribute run config; project/local config may also register project workflow refs, while global config may register global workflow refs. Missing config is allowed until a workflow actually needs configured agents.
- `.trailstep/config-local.json` is an optional, gitignored local project-scope override merged after project and global config; agent entries merge by name, `workflows` merges one level deeper by namespace bucket, and other top-level keys are replaced by later scope. There is no separate global-local override.
- `trailstep init [--scope <local|project|global>]` interactively writes literal agent config entries; it starts with `default`, can add named agents/custom providers, and prompts for scope when omitted.
- `trailstep add --scope local` registers into `.trailstep/config-local.json` instead of the shared `.trailstep/config.json`; use it for machine-specific agent targets or workflow registrations that should not be committed.
- `trailstep add` registers direct workflow files/exports, selected bundle workflows, versioned npm package specs, or explicit `github:<owner>/<repo>` package specs into local/project/global config and can distribute generated workflow skills with `--project-skill` or `--user-skill`. `--scope`, `--namespace`, and `--name` are all optional: scope prompts (single-select) when omitted unless `--yes` uses project scope; multi-workflow sources prompt for one or more workflows unless `--yes` selects all; namespace defaults to `"project"` for local/project scope or `"global"` for global scope; name defaults to the workflow's own `id`. Namespace `"project"`/`"global"` are scope-reserved — using either with a mismatched scope is rejected because the entry would be unresolvable. With `--yes`, registration conflicts fail unless `--force` replaces them.
- `trailstep remove <namespace>/<name>` deletes a registration, searching local, project, then global config unless `--scope` narrows it; it errors instead of guessing when a ref matches more than one scope.
- Published `@trailstep/cli` keeps `@trailstep/core` as both a `workspace:*` build dependency and a versioned peer dependency.
- Starting a run may omit `workflowRunName` and use generated names; persisted-failure manual retry is handled by `trailstep retry`, not `run --resume`; automatic retry is core-owned and may run before terminal persistence, while provider CLI `--resume` is separate provider repair.
- `trailstep continue` targets an active interactive session from `TRAILSTEP_INTERACTIVE_FILE`, `--interactive-file`, or no-arg prompt selection, then validates session-file or JSON output before completing the protocol; `trailstep cancel` cancels active interactive sessions.
- When adding commands, route through the command registry and update tests before claiming behavior in README or documentation.
