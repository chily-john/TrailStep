---
kind: rules
paths:
  - packages/cli/src/internals/commands/
summary: Top-level CLI command implementations for initializing/managing agent config, adding/installing workflow packages, continuing, canceling, listing/editing workflows, retrying failed runs, listing run summaries, doctor deprecation scanning, self-update planning, running, and checking workflow packages.
triggers:
  - trailstep add
  - trailstep init
  - trailstep agents
  - trailstep workflows
  - trailstep retry
  - trailstep runs
  - trailstep continue
  - trailstep run
  - trailstep update
  - trailstep doctor
  - trailstep skill-check
  - CLI command
  - command parsing
---

# packages/cli/src/internals/commands/

Enter here when changing a user-facing `trailstep` command. Command modules should depend on shared internals for discovery, config, workflow references, and input loading.

## Subdirectories

- `add/`: Enter when changing `trailstep add` registration of workflow files, bundle workflows, npm package specs, or GitHub package specs into local/project/global config, `--workflow` single/list/all selection, `--yes` defaulting, scope/namespace/name behavior, conflict handling, or project/user skill generation options.
- `agents/`: Enter when changing `trailstep agents` first-agent setup, interactive config editing, `set/delete/rename` for scoped literal agent entries, or agent-ref maintenance.
- `cancel/`: Enter when changing interactive run cancellation via `trailstep cancel`.
- `continue/`: Enter when changing interactive session completion via `trailstep continue`, including no-argument active-session selection or explicit interactive-file targeting.
- `doctor/`: Enter when changing `trailstep doctor` deprecation scanning for registered/discovered workflow sources.
- `init/`: Enter when changing `trailstep init` agent config bootstrapping or packaged usage-skill installation tracking for local, project, or global scope.
- `workflows/`: Enter when changing `trailstep workflows` grouped registered-entry + discovery output, or the interactive drill-in edit/remove flow.
- `remove/`: Enter when changing `trailstep remove` registration deletion, package metadata cleanup, package install cleanup/preservation notices, or its multi-scope disambiguation.
- `run/`: Enter when changing workflow execution arguments, input loading, config use, result output, or run exit behavior.
- `runs/`: Enter when changing `trailstep runs` listing of active, recent failed, or all configured-runs-root summaries.
- `retry/`: Enter when changing `trailstep retry` argument parsing, failed-run retry target selection, retry event logging, or retry exit behavior.
- `update/`: Enter when changing `trailstep update` scope parsing, self-update target resolution, workflow package target resolution, npm metadata use, deprecation preflight, or update execution behavior.
- `skill-check/`: Enter when changing `trailstep skill-check` validation for workflow packages missing `SKILL.md`.

## Rules

- Keep command output simple and tied to actual discovered workflows, runtime results, persisted run summaries, or skill-check findings.
- Interactive `continue` and `cancel` commands use `TRAILSTEP_INTERACTIVE_FILE`; do not accept migrated environment fallbacks.
- `trailstep runs` prints active runs, recent failed runs from the last 7 days, and all runs from the configured runs root (default `.trailstep/runs`); consumed retried failures do not keep a completed run in the recent-failed section.
- `trailstep retry` with no args prompts to select and confirm an eligible configured-runs-root entry with a latest unresolved failure or dangling `step.started` interruption (asking for a workflow ref only when old events lack one) and exits cleanly when none are eligible; `trailstep retry <workflow-ref> <runName>` retries the named run from the same runs root, resolves config and workflow refs like `run`, emits terminal event logging, reports the retried run directory, and rejects `--step` because V1 targets the latest unresolved failure/interruption.
- `trailstep add` accepts workflow files/direct refs, bundle packages, versioned npm package specs, explicit `github:<owner>/<repo>` package specs, `--project-skill`, and `--user-skill`; npm/GitHub specs install into cwd as dev dependencies for local/project scope or `~/.trailstep/packages` as dependencies for global scope using the detected package manager (adding pnpm `--workspace-root` at pnpm roots) before discovery, and store package workflow metadata (including install ownership) with the registration. Existing npm installs in non-`--yes` mode print version/source/spec/root before prompting to reuse, reinstall/upgrade, or cancel. `--yes` makes omitted scope default to project, selects all discovered workflows when `--workflow` is omitted, and suppresses interactive skill-choice prompts. `--workflow <name>`, comma-separated names, or `*` selects direct or bundle workflows; otherwise non-`--yes` multi-export direct sources prompt with alphabetized multi-select choices before registering selected `<source>#<export>` refs. Fresh package installs are rolled back when add cancels before registration or all selected workflows are skipped; reused existing packages are preserved. `--dry-run` is package-backed only: it prints npm/GitHub package add plans without installing, writing registrations or skills, or distributing skills, and can plan workflow registrations only from an already-installed package. Bundle workflow prompts are also multi-select, include `Select all`, use manifest workflow keys or package-root workflow exports when manifest metadata is absent, and preserve manifest order when present. `--name` is valid only for one selected workflow; existing registrations warn and skip unless `--force` replaces them, while `--yes` conflicts error before partial writes unless `--force` is set, and bulk adds print a registered/skipped/skill-warning summary. Interactive non-`--yes` adds prompt for project/user skill choices when skill flags are omitted, writes `.trailstep/skills/<skill>/SKILL.md`, and distributes requested skills through the `skills` CLI without failing registration on skill write/distribution errors. After registration, non-`--yes` adds prompt uncovered workflow agent roles once per role name across successful registrations to use a named agent, create one in the chosen scope, or skip; promptless non-`--yes` adds error when a role has no configured target.
- `trailstep init` writes one or more literal agent entries (starting with `default`) into local, project, or global config through the shared agent setup wizard, can add fully configured custom provider entries from prompts, records `skillInstallations.trailstep` with the packaged skill hash after installing the packaged usage skill, and skips prompting/installing when a current marker already exists in an applicable config scope.
- `trailstep remove` removes package metadata with the registration and uninstalls the last matching TrailStep-owned package install using that install root's detected package manager; it preserves package installs when metadata is stale/mismatched, the package remains referenced, or the install is not TrailStep-owned, and reports manual cleanup when uninstall fails.
- `trailstep agents` without a subcommand prompts for scope, bootstraps `default` with the shared setup wizard when that scope has no configured agents, edits named agents, and manages workflow role overrides as named-agent refs or inline one-offs; saved custom-provider targets write their provider config into the same scope; `set/delete/rename` require explicit scope, `set` requires provider but treats omitted/blank `--model` as provider default before replacing a named agent with one literal target, `delete` blocks when raw config refs still point at that agent, and `rename` updates config refs after renaming the agent entry.
- `trailstep add`'s scope/namespace/name resolution, the reserved-namespace-vs-scope guard, and the cross-file duplicate check live in `add-command.ts` but the underlying metadata-aware config read/write/enumerate/delete/move primitives live in `../../workflow-registry/workflow-registry.ts` — shared with `remove` and `workflows`' drill-in rename flow. Prompt helpers (`promptText`/`promptSelect`/`promptMultiSelect`/`promptYesNo`) live in `../../prompts/prompt-helpers.ts`, also shared across these three commands.
- `trailstep continue` with no args prompts for an active `.trailstep/runs/**/interactive.json` session, `--interactive-file <path>` targets a protocol file directly, explicit output modes (`--session-file`, `--json-file`, `--json`) still require `TRAILSTEP_INTERACTIVE_FILE`, and all modes validate submitted output against the session schema before marking it completed.
- `trailstep doctor` scans registered workflow sources and discoverable workflow packages against installed `@trailstep/core`/`@trailstep/authoring` manifest versions, prints formatted TrailStep deprecation findings, skips unreadable targets, returns exit code `2` for blocking findings, and returns exit code `1` for warnings.
- `trailstep update` accepts at most one scope flag among `--all`, `--workflows`, or `--workflow <name>`; default self scope scans registered/discovered workflows for TrailStep deprecations against target TrailStep package versions, prints planned `@trailstep/core`, `@trailstep/authoring`, and `@trailstep/cli` package updates from npm metadata, then requires `--yes`, `--assume-yes`, or prompt confirmation before rewriting `package.json` and running install. Workflow scopes resolve only registered npm package targets by package-metadata install root, skip local-file refs, GitHub refs, stale package metadata, and missing package metadata, scan all sources in targeted bundle packages for deprecations, require the target package in the install-root dependencies/devDependencies/peerDependencies, print range-to-version workflow package update plans, use npm metadata from the install root for latest stable dependency updates, and rewrite `package.json`/run install when updates are available. `--all` applies self updates in the command cwd and workflow package updates in each target install root, runs install per root, and uses target TrailStep versions for workflow-package preflight. Bare `--workflow <name>` errors when multiple registrations share that name. Blocking findings stop the update plan unless `--force` is set.
- Update command tests before updating README examples or usage text.
