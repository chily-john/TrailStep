---
kind: rules
paths:
  - packages/cli/src/internals/
summary: Internal command registry, command implementations, discovery, workflow package ref/install/uninstall helpers, package-manager/npm-registry/installed-version helpers, deprecation-scan helpers, agent-config initialization/editing helpers, config loading, input loading, interactive continuation, configured runs-root resolution, doctor deprecation scanning, update command self-update planning, retry command wiring, runs command listing, skill checks, workflow registration, workflow package metadata, workflow skill generation/distribution, registered workflow refs, agent ref maintenance, workflow resolution, and workflow-reference parsing for the CLI.
triggers:
  - CLI internals
  - command registry
  - run summaries
  - TRAILSTEP_RUNS_ROOT
  - workflow id
  - CLI config
  - agent config
  - workflow discovery
  - bundle workflow
  - direct workflow file
  - workflow skill
---

# packages/cli/src/internals/

Enter here when changing CLI behavior behind the public `main()` entrypoint. Internals are testable modules, not public package APIs unless explicitly re-exported from `src/index.ts`.

## Subdirectories

- `agent-config/`: Enter when changing shared flows for literal agent target prompts, agent entry item editing, save confirmation, config-scope paths, or rename/delete referrer handling.
- `commands/`: Enter when changing `add`, `remove`, `init`, `agents`, `continue`, `workflows`, `run`, `runs`, `retry`, `cancel`, `doctor`, `update`, or `skill-check` command behavior and command-specific argument parsing.
- `deprecation-scan/`: Enter when changing update preflight discovery, scanning, or formatting for TrailStep deprecated symbols in workflow source files.
- `config/`: Enter when changing optional `.trailstep/config.json`/`.trailstep/config-local.json` loading, merge precedence, and CLI-facing config errors.
- `discovery/`: Enter when changing workflow package discovery from consumer dependencies.
- `package-manager/`: Enter when changing package-manager detection, install command execution helpers, package.json dependency rewriting, installed TrailStep package version resolution, or npm registry metadata fetching.
- `prompts/`: Enter when changing the shared `promptText`/`promptSelect`/`promptMultiSelect`/`promptYesNo` interactive-prompt helpers used by `add`, `remove`, and `workflows`.
- `workflow-reference/`: Enter when changing `<package:workflowExport>` or `<package-or-path#workflowName>` parsing rules.
- `workflow-registry/`: Enter when changing shared config-file read/write/enumerate primitives (`configPathForScope`, raw read/write, package-metadata-aware list/write/delete/move/lookup helpers, cross-scope duplicate lookup, the reserved-namespace and reserved-character guards) used by `add`, `remove`, `run`, and `workflows`.
- `workflow-packages/`: Enter when changing npm/GitHub package spec parsing, scope-aware install roots/save args, scoped package installation used before `trailstep add` bundle discovery, or package cleanup after `trailstep remove`.
- `workflow-resolution/`: Enter when changing run-command resolution between discovered workflow ids, project/global-registered config refs, package-metadata install roots, bundle manifest refs, and direct workflow source references.
- `workflow-skills/`: Enter when changing generated workflow skill naming, content, project skill file writing, leftover generated-skill warnings, or `skills` CLI distribution.

## Files

- `agent-config/agent-entry-items-flow.ts`: Change when replacing, adding, removing, reordering, or editing literal agent entry items.
- `agent-config/save-confirm-flow.ts`: Change when save/discard choices for named agents or workflow role overrides change.
- `command-registry.ts`: Change when registering a new top-level command; current explicit commands are `add`, `remove`, `init`, `agents`, `continue`, `workflows`, `runs`, `retry`, `cancel`, `doctor`, `update`, and `skill-check`, with other argv falling through to `run`.
- `command.types.ts`: Change when command context, usage text, command interface, prompt text/select/multi-select/confirm injection, env injection, home-dir injection, skills CLI injection, run-name injection, package command runner injection, or deprecation manifest injection changes.
- `workflow-packages/package-ref.ts`: Change when npm/GitHub package spec detection or GitHub shorthand rejection for `trailstep add` changes.
- `workflow-packages/install-root.ts`: Change when local/project vs global workflow-package install roots or npm save args change.
- `workflow-packages/npm-package-installer.ts`: Change when `trailstep add` package install roots, package.json bootstrapping, npm install invocation, GitHub installed-package identification, installed manifest handling, or TrailStep-installed ownership metadata changes.
- `workflow-packages/package-uninstall.ts`: Change when `trailstep remove` package uninstall, preservation, failure reporting, or package-command invocation changes.
- `workflow-registry/workflow-registry.ts`: Change when raw registry reads/writes/enumeration, metadata-aware single-entry lookup, duplicate-scope lookup, delete/move metadata sync, package install-ownership metadata validation, or registration validation changes.
- `workflow-resolution/workflow-resolution.ts`: Change when registered/discovered/bundle/direct resolution order, registry metadata install-root selection, or registered-ref recursion changes.
- `runs-root.ts`: Change when `TRAILSTEP_RUNS_ROOT` or default `.trailstep/runs` resolution for run, runs, or retry changes.
- `package-manager/package-manager.ts`: Change when lockfile/packageManager detection or detected install command execution changes.
- `package-manager/npm-registry.ts`: Change when `npm view` metadata fetching or registry-error handling changes.
- `package-manager/installed-packages.ts`: Change when installed `@trailstep/core`, `@trailstep/authoring`, or `@trailstep/cli` version resolution changes.
- `package-manager/package-json-rewrite.ts`: Change when update-command package.json dependency rewrites or range-style preservation changes.
- `commands/doctor/doctor-command.ts`: Change when doctor argument parsing, output/exit behavior, or installed `@trailstep/core`/`@trailstep/authoring` manifest version resolution changes.
- `commands/update/update-targets.ts`: Change when TrailStep self-update target selection, peer compatibility, package range discovery, or shared update target package-json helpers change.
- `commands/update/workflow-update-targets.ts`: Change when workflow package update target resolution, dependency-section lookup, npm metadata use, latest-stable selection, local-file skips, or ambiguous bare workflow-name handling changes.
- `deprecation-scan/scan-targets.ts`: Change when doctor/update deprecation scan target collection, scan modes, direct-file inclusion, discovered package inclusion, bundle source resolution, or `resolveBundleWorkflowScanTargets` changes.
- `workflow-resolution/bundle-resolver.ts`: Change when bundle manifest resolution, `hasBundleWorkflowManifest`/`readBundleWorkflowManifest`/`parseManifestTarget` helper exports, workflow imports, or fresh import cache-busting changes.
- `workflow-resolution/direct-file-resolver.ts`: Change when direct workflow source loading, extensionless/index resolution, TypeScript source imports, `#export` selection, direct-source export listing, or direct-source helper exports change.
- `workflow-skills/generated-skill-warning.ts`: Change when commands warn about leftover generated skill directories.
- `workflow-skills/workflow-skill-content.ts`: Change when generated workflow skill names, frontmatter, input instructions, or metadata handling changes.

## Rules

- Add new commands through `command-registry.ts`; do not branch directly in `index.ts`.
- Direct workflow sources may be `.ts`, `.mts`, `.js`, `.mjs`, extensionless, directory indexes, or include `#export`; `.tsx` is intentionally unsupported.
- Local/path refs containing `#` stay bundle refs when the package target has `trailstep.workflows`; otherwise they load as direct workflow files.
- Direct workflow files may omit `inputShape`; generated skills for no-input workflows run without `--input-file`.
- Generated workflow skills use `sk-<sanitized workflow name>` for the skill directory/frontmatter name and input/context file stems; namespace is carried in a `[namespace]` description prefix.
- Deprecation scan target collection includes direct-file workflow refs for workflow-source scans (doctor/self-update preflight) but skips them for workflow-package update scans.
- Workflow-package update scans check every workflow source in a targeted bundle package, not only the selected registered workflow.
- Deprecation scanner findings only consider named imports from `@trailstep/core` and `@trailstep/authoring`.
- Deprecation scan targets use workflowMetadata install roots for registered package-backed refs, reuse discovery and bundle-manifest resolution helpers, and skip unreadable or malformed package targets.
- Route run, runs, and retry artifact lookup through `runs-root.ts` so `TRAILSTEP_RUNS_ROOT` can centralize run directories outside the command cwd.
- Workflow npm/GitHub package installs use the command cwd with `--save-dev` for local/project scopes and `~/.trailstep/packages` with `--save` for global scope; CLI-run installs record `installOwnership: "trailstep-installed"`, reused existing npm packages record `"reused-existing"`, and GitHub refs must be explicit `github:<owner>/<repo>` refs.
- Registered package workflow resolution uses `workflowMetadata.installScope` to resolve package/bundle targets from the same install root used at add time.
- Use `writeWorkflowRegistryEntries` for registration writes and config-level delete/move helpers for removals or renames that must keep `workflowMetadata` synchronized with `workflows`.
- Keep errors intended for users as `CliUsageError`, `CliInputError`, `CliConfigError`, or `WorkflowResolutionError` so `main()` can return exit code `1` cleanly.
