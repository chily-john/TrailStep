---
name: trailstep
description: Use when installing, configuring, updating, or running TrailStep workflows and providers with the TrailStep CLI.
---

# TrailStep usage skill

Use TrailStep to install, discover, run, continue, retry, and observe durable typed coding-agent workflows from project files or packages.

## CLI quick start

- Create config and install the packaged TrailStep skills with `trailstep init`.
- Update TrailStep and refresh tracked packaged skills with `trailstep update`; use `trailstep update --project` only when intentionally updating project authoring/runtime packages.
- Configure agent targets with `trailstep agents` or `trailstep agents set <name> --provider <provider> --scope <project|global>`.
- List registered workflows with `trailstep workflows`.
- Add reusable workflow packages with `trailstep add <package-or-ref>`; installed workflows become discoverable by supported agents through the TrailStep MCP server (`trst_*` tools) rather than generated per-workflow skills.
- Run a workflow with inline JSON: `trailstep <workflow-ref> --input '{"request":"..."}'`.
- Pipe one-shot JSON on stdin: `printf '%s\n' '{"request":"..."}' | trailstep <workflow-ref> --input-file -`.
- Run a workflow with a reusable JSON input file: `trailstep <workflow-ref> --input-file .trailstep/inputs/input.json`.
- Continue waiting or interrupted runs with `trailstep continue`.
- Answer human/parent waits with `trailstep answer <runName> <waitId> --json '{"answer":"..."}'`.
- Retry failed work with `trailstep retry <workflow-ref> <runName>`; retry instead of inventing a separate resume mechanism.
- Inspect active/history with `trailstep runs`, `trailstep watch`, and `trailstep output <runName>` when available in the installed CLI version.
- Manage run artifact lifecycle with `trailstep storage status`, `trailstep storage gc --dry-run`, `trailstep storage restore <runId>`, `trailstep storage pin <runId>`, and `trailstep storage delete <runId>`.
- Open a managed standalone agent session with `trailstep open [agent-or-provider]` or bare `trailstep` when a default agent is configured.

## Workflow refs

TrailStep accepts these workflow reference forms:

- direct refs such as `./workflows/review.ts#review`
- registered refs such as `project/review`
- bundle refs such as `@acme/workflows#review`

Use direct refs for local files, registered refs for named project or user workflows, and bundle refs for exported workflows from installed packages.

## Inputs and workflow skills

- Workflow inputs should be JSON object values, not raw prose or arrays.
- Prefer `--input-file -` for one-shot agent-generated JSON; use a named `--input-file` for large context and reproducible runs.
- TrailStep coerces stringified scalar inputs into the types declared by the workflow input shape before validating and persisting the run; nested objects and arrays must already be JSON objects.
- Per-workflow agent discovery is provided by the TrailStep MCP server (`trst_*` tools) and packaged skills; there are no per-workflow generated skills.

## Run lifecycle

- Continue waiting or interrupted runs with `trailstep continue`.
- Answer human/parent waits with `trailstep answer <runName> <waitId> --json '{"answer":"..."}'`; add `--branch <branchId>` to disambiguate same-id waits pending on parallel branches, and `--continue` to persist the answer and resume in one step.
- Retry failed work with `trailstep retry <workflow-ref> <runName>`; retry instead of inventing a separate resume mechanism.
- Cancel with `trailstep cancel <runNameOrRunDir> [--reason '<text>']`; clear a stale pending cancel marker with `trailstep cancel <runNameOrRunDir> --clear`; cancel the active interactive session with `trailstep cancel --reason '<text>'`.
- The cancellation marker is a pending request, not a record of an honored cancellation; `trailstep continue` and `trailstep retry` consume a pending marker, and already-terminal runs are never re-cancelled by a stale marker.

### Automatic retries

- Retries default to a single automatic retry: `retry.maxAttempts` defaults to `2` and `retry.retryOn` defaults to `"transient"`.
- Only transient failures retry by default (`step_timeout`, `agent_provider_unavailable`, `agent_provider_failed`, `agent_provider_spawn_error`, `agent_provider_timeout`); deterministic failures fail on the first attempt.
- Opt in with `retryOn: "always"` to retry every failure, or set `maxAttempts: 1` to disable retries; failures may also opt in explicitly with `retryable: true`, and the terminal `step.failed` event is emitted exactly once.

## Execution settings

- Agent steps accept an execution block (`tools`, `skills`, `mcp`, `extensions`, `contextFiles`) for per-step hygiene.
- Configure globally (`settings.execution`) and per workflow (`workflows.<id>.settings.execution`).
- Blocks merge field by field with precedence step execution > per-workflow config > global config > agent role, so a block naming only `contextFiles` changes only that field.
- `contextFiles` defaults to `true` and accepts `true`, `false`, or `"project-only"`.
- An invalid block fails fast before any provider process starts, naming the config path.

## MCP server

- Run the TrailStep MCP server for a project with `trailstep mcp [--project <dir>]` — a foreground stdio server exposing registered workflows to MCP clients as `trst_*` tools.
- `trailstep add` generates per-workflow tool JSONs under `.trailstep/mcp/`; `trailstep update --workflows` refreshes them. Regenerate only through `add`/`update` — never hand-edit generated `.trailstep/mcp` artifacts.
- Default exposure is one `trst_<id>` tool per workflow. Set `mcp.perWorkflowTools: false` in TrailStep config to fall back to `trst_list` plus the generic `trst_run_workflow`, `trst_watch`, `trst_answer`, and `trst_resume` tools.
- `trailstep init` and `trailstep add` offer to register the server with detected coding agents via `add-mcp` (project, local gitignored, or global scope); declining or running headless prints the exact manual `npx add-mcp ...` command. pi is registered by writing pi's own MCP server entry directly (project/local scope: `<project>/.pi/mcp.json`; global scope: `$PI_CODING_AGENT_DIR` or `~/.pi/agent/mcp.json`) so pi's `exposure` / `toolExposure` profile can be applied; every other coding agent is registered through `add-mcp`.
- MCP tools honor the same environment contract as the CLI: `TRAILSTEP_RUNS_ROOT` overrides the runs root, and `TRAILSTEP_CLI_ENTRY` points at the CLI entry used for background runs and resumes (effectively required on Windows — the win32 PATH fallback is refused).
- `trst_run_workflow` is non-blocking: it returns `{runId, runDir, status, workflow}` immediately with `status: "started"` only once the run directory materializes, or `status: "failed"` plus `error` (reported as an MCP `isError` result) when the run never starts; observe it with `trst_watch` and answer waits with `trst_answer`.
- The MCP tool surface covers starting, watching, answering, resuming, and listing workflow runs; cancel, retry, storage, and other lifecycle operations stay on the CLI.

## Safety and run artifacts

- Do not manually edit `.trailstep/runs`.
- Local run artifacts are runtime outputs, not source of truth.
- Configure filesystem run cleanup under `storage.lifecycle` with duration strings such as `compressAfter: "7d"` and `deleteAfter: "30d"`; per-workflow overrides live under `storage.lifecycle.workflows`.
- `trailstep storage gc` applies the configured lifecycle and skips pinned runs. `restore` refuses to overwrite hot runs and removes the archive copy after success. `pin`/`unpin` operate on hot runs; restore archived runs first. `delete` removes hot or archived runs but refuses pinned runs.
- Use `trailstep continue` for normal continuation and `trailstep retry` for failed steps instead of adding a custom resume path.
- Keep reusable workflow behavior in workflow source and package exports, not in generated run directories.
- If TrailStep reports that the CLI or packaged skills are out of date, run `trailstep update`.

## Provider usage and authoring

Use provider commands when connecting TrailStep to a coding-agent CLI or package.

Common commands:

- `trailstep providers add <path-or-package> --scope project`
- `trailstep providers inspect <path-or-package>`
- `trailstep providers test <provider> --scope project`
- `trailstep agents set default --provider <provider> --scope project`

Author either a manifest-only provider or a hook-based provider package.

### Manifest-only provider

Create a `my-provider.trailstep-provider.json` file with serializable data only:

```json
{
  "schemaVersion": 1,
  "id": "example",
  "displayName": "Example Provider"
}
```

Do not embed functions in manifests.

Working args may use `{{promptFile}}`, `{{outputFile}}`, `{{model}}`, and `{{thinking}}`. Interactive args may also use `{{prompt}}`. Guard optional overrides with `{{#model}} ... {{/model}}` and `{{#thinking}} ... {{/thinking}}` conditional blocks.

### Hook-based provider package

Export `trailstepProvider` from the package root and keep hooks beside the manifest:

```ts
export const trailstepProvider = {
  manifest: {
    schemaVersion: 1,
    id: "example",
    displayName: "Example Provider",
  },
  hooks: {
    beforeWorkingAgent: async () => undefined,
  },
};
```

Hook-based provider packages may execute provider package code and should be trusted like installed npm dependencies.

Provider authoring checklist:

- provider id
- display metadata
- working invocation
- prompt delivery
- output parsing
- model flags
- thinking flags
- env requirements
- interactive support
- repair support
- resume support
- `trailstep providers inspect <path-or-package>`
- `trailstep providers test <provider> --scope project`
