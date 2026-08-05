# @stepkit/cli

Command-line discovery, registration, and local execution for StepKit workflows.

## Commands

```bash
stepkit init [--scope <local|project|global>]
stepkit agents [--scope <local|project|global>]
stepkit add <workflow-file-or-bundle> [--scope <local|project|global>] [--namespace <namespace>] [--name <name>] [--workflow <workflow>] [--project-skill] [--user-skill] [--force]
stepkit remove <namespace>/<name> [--scope <local|project|global>]
stepkit workflows
stepkit doctor
stepkit update [--all | --workflows | --workflow <name>] [--force] [--assume-yes]
stepkit <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]
stepkit retry [<workflow-ref> <workflowRunName>]
stepkit continue --session-file <path>
stepkit continue --json-file <path>
stepkit continue --json '<json>'
```

Workflow refs include:

```bash
stepkit ./workflows/review.mjs
stepkit ./workflows/review.mjs run-one
stepkit project/review
stepkit global/cleanup
stepkit @acme/workflows#release
stepkit ./workflows/index.ts#reviewWorkflow
```

## Workflow refs

- Direct local source refs use a relative or absolute path such as `./workflows/review.ts`, `./workflows/index.ts#reviewWorkflow`, or `./workflows#reviewWorkflow`. Direct refs may be `.ts`, `.mts`, `.js`, `.mjs`, extensionless files, or directories with an index file; append `path#exportName` to select a named workflow export. `.tsx` is intentionally unsupported.
- Registered refs such as `project/review`, `global/cleanup`, or unqualified `review` resolve through string entries under `.stepkit/config.json`, `.stepkit/config-local.json`, or `~/.stepkit/config.json` `workflows`. `.stepkit/config-local.json` is gitignored and merges over the committed `.stepkit/config.json` per workflow name, so project and local registrations coexist. Project entries take precedence for unqualified names.
- Bundle refs use `#`, for example `@acme/workflows#release`. The package must expose `stepkit.workflows` manifest metadata mapping workflow names to module exports.
- Legacy `package:export` refs remain supported for compatibility with package export discovery.

`workflowRunName` is optional when starting a run. If it is omitted, StepKit generates a readable run name from the workflow ref, timestamp, and short suffix. Retry targets an existing `.stepkit/runs/<workflowRunName>` artifact:

```bash
stepkit ./workflows/review.mjs
stepkit ./workflows/review.mjs run-one
stepkit retry ./workflows/review.mjs run-one
```

## Agent configuration

`stepkit init` bootstraps `.stepkit/config.json`, `.stepkit/config-local.json`, or `~/.stepkit/config.json` using the current config schema. Built-in providers such as `claude`, `codex`, `pi`, and `gemini` can be referenced directly from `agents.*`; other command-backed providers are declared under `customProviders`.

```json
{
  "version": 1,
  "customProviders": {
    "local-reviewer": {
      "binary": "reviewer-agent",
      "args": ["{{promptFile}}", "{{outputFile}}"]
    }
  },
  "agents": {
    "default": [{ "provider": "claude", "model": "sonnet" }],
    "reviewer": [{ "provider": "local-reviewer" }],
    "pairing": [{ "provider": "claude", "model": "opus", "permissionMode": "prompt" }]
  },
  "workflows": {
    "review": {
      "agents": {
        "reviewer": [{ "ref": "reviewer" }]
      }
    }
  }
}
```

`stepkit agents` edits the same agent/provider configuration interactively.

**Security note:** interactive `claude`-provider agent targets default to `--dangerously-skip-permissions` (no per-tool confirmation) when `permissionMode` is omitted. Set `"permissionMode": "prompt"` on an agent-target entry, as shown above for `pairing`, to restore per-tool confirmation for that target.

## Registration

`stepkit add` writes workflow registry entries without installing packages. `--scope`, `--namespace`, and `--name` are all optional — the common case is just:

```bash
stepkit add ./workflows/review.mjs
stepkit project/review
```

With no flags, `add` prompts once for scope (a single select — `local` for personal-to-you-in-this-repo, `project` for shared with your team, `global` for global across all your projects; there is no silent default). Namespace then defaults to `"project"` for `project`/`local` scope, or to `"global"` for `global` scope (with an optional follow-up prompt to pick a custom namespace, useful for avoiding collisions across multiple globally-registered bundles). Name defaults to the workflow's own `id` (set by the author via `defineWorkflow({ id: "..." })`). Pass `--scope`/`--namespace`/`--name` explicitly to skip any of these prompts or override the default:

```bash
stepkit add ./workflows/review.ts#reviewWorkflow --scope local
stepkit add @acme/workflows --workflow review --scope global --namespace acme --name review
stepkit add @acme/workflows --workflow review,release,cleanup
stepkit add @acme/workflows --workflow '*'
```

A workflow `id` containing `/`, `#`, `:`, or that looks like a file path can't be used as a default registration name (each of those breaks or ambiguates how registered refs are resolved) — pass `--name` explicitly for those.

Add `--project-skill` or `--user-skill` to also generate a StepKit workflow skill source at `.stepkit/skills/sk-<sanitized-name>/SKILL.md` and ask the upstream `skills` CLI to install it into the selected agent skill scope. Generated skill descriptions are prefixed with `[<namespace>]` to show the registration origin without appending the namespace to the skill name. Distribution is best-effort: registration still succeeds if the `skills` CLI cannot be resolved or exits with an error.

Prefer matching the registration scope and skill scope. A project skill that points at a global- or local-scoped registration may not resolve for teammates, and a user skill that points at a project- or local-scoped registration only works from that project; StepKit prints warnings for these scope mismatches.

Generated skills pass workflow input through `stepkit <workflow-ref> --input-file <path>`. Workflow input must be a JSON object. For dense conversation context, write the context to a markdown file and pass an object wrapper such as `{ "sessionFile": ".stepkit/inputs/sk-review-context.md" }`.

Remove a registration with `stepkit remove <namespace>/<name>` or the Remove action in `stepkit workflows`. Since `project` and `local` scope both default to the same `"project"` namespace, the same ref can exist in either (or both) config files; `remove` searches local, then project, then global unless `--scope` is passed, and asks you to disambiguate with `--scope` if the ref matches more than one:

```bash
stepkit remove project/review
stepkit remove project/review --scope local
```

A custom namespace reused independently at both a project-family scope and `global` scope is not safe — qualified-ref lookups check the project-merged registry first, so a `global`-scope entry under a namespace that also exists in the project registry would be masked. Prefer scope-distinct namespaces, or the defaults above, for anything registered at `global` scope.

## Discovery and workflows

`stepkit workflows` prints registered workflows grouped by scope — `local`, `project (shared)`, then `global`, in that order, each heading omitted when it has no entries — followed by legacy package-discovered workflows under a `Discoverable workflow packages:` heading (or as a plain list with no heading, if there are no registered entries to disambiguate from). Package discovery reads the current project's direct dependencies and dev dependencies, resolves packages whose `package.json` contains the `stepkit-workflow` keyword, imports their module entry point, and prints exported workflow objects as package-qualified ids such as `@acme/workflows:releaseWorkflow`. Discovered-but-unregistered packages are read-only in this listing; only registered entries can be selected below.

It then prompts to select a registered workflow to drill into. Selecting one opens a detail page showing the workflow's target ref and description (or `(no description)`), with a menu to edit its `Namespace`, edit its `Name`, go `Back to workflow list`, or `Exit`. Editing the namespace offers `local`/`project`/`global` presets plus a free-text option; editing the name is a free-text prompt. Either write immediately to the same scope's config file (scope itself cannot be changed this way — remove and re-add to move a registration across scopes) and return to the detail page so you can keep editing or exit.

## Doctor and update

`stepkit doctor` scans registered workflow sources and discoverable workflow packages for StepKit deprecation manifest findings using the installed `@stepkit/core` and `@stepkit/authoring` package manifest versions. A clean run prints `No StepKit deprecation findings.` and exits `0`; warning findings print `warning <package>/<symbol> <path>:<line>:<column> <message>` and exit `1`; blocking findings print `blocking <package>/<symbol> <path>:<line>:<column> <message>`, add `Doctor found blocking deprecation findings.`, and exit `2`.

The deprecation scanner is intentionally conservative and text-based. It matches non-aliased named imports from `@stepkit/core` and `@stepkit/authoring` in Node-readable workflow source files; aliased imports such as `import { step as s } ...`, dynamic usage, generated code paths outside registered or discoverable workflow entry points, and unreadable files are skipped until scanner coverage expands.

`stepkit update` has two update scopes. By default it plans StepKit self-updates for `@stepkit/core`, `@stepkit/authoring`, and `@stepkit/cli`; `--workflows` plans registered workflow package updates without mutating local StepKit package entries; `--workflow <name>` narrows that workflow package update to a registered `namespace/name` or unique bare workflow name, and if no registration matches, treats `<name>` as an explicit raw package name; `--all` combines self and workflow package updates. Workflow package updates act only on registered workflow package sources or explicit raw package names, not on keyword-discovered packages from `stepkit workflows` discovery. Direct-file workflow registrations are scanned during self-update preflight but skipped as workflow package update targets because local files have no package version to update.

Before writing, `stepkit update` scans the affected workflow sources for deprecations, prints any findings, and blocks on blocking findings unless `--force` is passed. `--force` only overrides deprecation blocking; registry lookup errors, dependency-target resolution errors, and package manager failures still fail the command. After confirmation (or `--assume-yes`), StepKit rewrites root `package.json` and runs the detected package manager as `<pnpm|npm|yarn|bun> install` based on lockfile, then `packageManager`, then `npm` fallback. If install fails, no rollback is attempted; fix the install problem and manually rerun the package manager install command.

## Execution

`stepkit <workflow-ref> [workflowRunName]` loads JSON object input from `--input`, from `--input-file`, or defaults to `{}`. The CLI runs the resolved workflow through `@stepkit/core` from the consuming project's working directory.

For agent steps, local `.stepkit/config.json` maps workflow roles and size tiers to entries under `agents.*`. Agent command templates run without a shell and may use `{{prompt}}`, `{{promptFile}}`, and `{{outputFile}}` placeholders declared by built-in providers or local `customProviders` config. Interactive steps inherit stdio and complete through `stepkit continue`; non-interactive command-backed agent steps write structured JSON output for validation.

Interactive steps complete through `stepkit continue` from the launched interactive process. StepKit sets `STEPKIT_INTERACTIVE_FILE`; the continue command requires that environment variable so it can validate and update the active `interactive.json` protocol file. Use `stepkit continue --session-file session-description.md` for default interactive steps, or `stepkit continue --json-file output.json` / `stepkit continue --json '{...}'` for custom structured output. Relative paths are resolved from the interactive step directory. If JSON or session-file validation fails, fix the artifact and run `stepkit continue` again.

When the prompt is passed directly with `{{prompt}}` or a built-in provider, no `prompt.txt` is written. `prompt.txt` is created only for custom provider invocations that use `{{promptFile}}`. Default interactive directories contain `interactive.json`, `output.json`, and `session-description.md`; structured JSON directories contain `interactive.json` and `output.json` unless a prompt file placeholder is used.

Run artifacts are written to:

```text
.stepkit/runs/<actualRunName>/
```

If the requested run name already exists, the runtime creates a suffixed directory such as `<workflowRunName>-2`. Event artifacts are persisted as `events.jsonl` in the run directory. Event ids are opaque; use JSONL/replay order, not id formatting, when reasoning about event order.

## Retry

Use `stepkit retry <workflow-ref> <workflowRunName>` for manual retry from the latest unresolved failure in an existing run artifact. `stepkit retry` with no arguments prompts for an eligible failed run when the terminal is interactive. Retry V1 targets the latest unresolved failure or interruption only; it does not accept `--step`.

Eligible manual retry targets include normal step failures, workflow failures that originated from a step `fail(...)`, and dangling `step.started` events left by an interrupted active step. Historical artifacts that lack a persisted workflow ref may prompt for one during interactive retry.

Automatic retry may already have retried conservative safe pre-dispatch failures before a terminal failure is persisted. The built-in default retry policy is `maxAttempts: 2`; effective policy precedence is step, workflow, global, then built-in, and `maxAttempts: 1` disables automatic retry for that policy. Manual `stepkit retry` remains available for eligible persisted failures after automatic retry is exhausted or skipped.

Automatic retry only treats `agent_provider_spawn_error` as a known safe direct failure, and treats `agent_target_exhausted` as safe only when every attempt detail is `agent_provider_spawn_error`. Provider process failures, provider output validation failures, code-step errors, prompt rendering errors, generic execution failures, and unknown or ambiguous failures are not automatically retried. Retry observability uses `step.attemptFailed` for non-terminal failed attempts and `workflow.retryStarted` with `retryKind: "automatic"`.

Workflow-level `--resume` is intentionally unsupported; use `stepkit retry` instead. Provider-level CLI `--resume` repair remains intact when a provider supports it, but it is separate from StepKit workflow resume and automatic retry.
