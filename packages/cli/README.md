# @trailstep/cli

`@trailstep/cli` provides the `trailstep` command for initializing TrailStep config, configuring agent providers, registering workflows, running workflows, continuing interactive steps, retrying failed runs, and managing package-backed workflow registrations.

## Install

Install globally if you want a `trailstep` command everywhere:

```bash
npm install --global @trailstep/cli
```

Or keep it project-local:

```bash
npm install --save-dev @trailstep/cli
npx trailstep --help
```

Use the equivalent command for your package manager if you use `pnpm`, `yarn`, or `bun`.

## Quick start

Prerequisite: install a CLI coding agent. TrailStep has been tested most heavily with Pi and Claude Code, so they currently have the best support.

```bash
trailstep init
trailstep
trailstep open claude
trailstep add @trailstep/create-flows@latest
trailstep workflows
trailstep project/grill-it-away
```

Use the interactive prompts to choose project scope, configure your agent/provider, install the TrailStep usage skill, select workflows, and generate project skills. Generated skills let supported coding agents discover and invoke workflows from the agent UI.

<details>
<summary>Scriptable setup</summary>

```bash
trailstep init --scope project --install-skill
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes
trailstep workflows
```

</details>

## Provider commands

Register a provider package or local manifest:

```bash
trailstep providers add <path-or-package>
trailstep providers add @trailstep/provider-pi --scope project
trailstep providers add ./providers/my-agent.trailstep-provider.json --scope project
trailstep providers inspect <path-or-package>
trailstep providers test pi --scope project
```

Hook-based provider packages may execute provider package code, so they should be trusted like installed npm dependencies. Use `trailstep providers test` as the safe verification path before using a provider in workflows.

### Declaring hygiene flags

Provider manifests may declare a `hygiene` block mapping execution fields — `tools`, `skills`, `mcp`, `extensions`, `contextFiles` — to the provider CLI's real argv flags (excerpt; other manifest fields unchanged):

```json
{
  "schemaVersion": 1,
  "id": "my-agent",
  "displayName": "My Agent",
  "hygiene": {
    "tools": { "flag": "--allowed-tools" },
    "skills": { "disableFlag": "--disable-skills" },
    "mcp": { "disableFlag": "--no-mcp" }
  }
}
```

`flag` is a value flag rendered as `flag value` (an explicit tools allowlist, or one named skill); `disableFlag` renders when the execution block suppresses that capability, and `skills` accepts both so non-empty lists load skills while an empty list disables discovery. Flags are split on whitespace into separate argv entries (`-c key=value` renders as `-c`, `key=value`); prefer the single-token `--flag=value` form for values. Omit any capability the CLI does not support per run — an omitted capability renders nothing (graceful no-op); never declare a guessed flag. Back-compat rule: manifest loaders ignore unknown keys, so `trailstep providers add` and `trailstep providers inspect` succeed even when a manifest carries keys the installed version does not read yet; unknown entries are skipped, never rejected.

## Common commands

```bash
trailstep
trailstep <agent-or-provider>
trailstep open [agent-or-provider]
trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]
trailstep agents
trailstep add <workflow-file-bundle-or-package> [--scope <local|project|global>] [--workflow <workflow>] [--project-skill] [--user-skill] [--yes] [--dry-run]
trailstep workflows
trailstep <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path|->]
trailstep watch <runNameOrRunDir> [--jsonl]
trailstep continue
trailstep retry <workflow-ref> <runName>
trailstep mcp [--project <dir>]
trailstep update [--all | --project | --workflows | --workflow <name>] [--yes]
```

See the repository [CLI reference (canonical copy in OpenViking)](viking://resources/trailstep/docs/cli-reference/) for the full command list and detailed behavior.

## MCP server

`trailstep mcp` runs the TrailStep MCP server in the foreground over stdio, exposing registered workflows to MCP clients as `trst_*` tools. `trailstep add` generates per-workflow MCP tool JSONs under `.trailstep/mcp/`, and `trailstep update --workflows` refreshes them; no other command rewrites those artifacts. `trailstep init` and `trailstep add` also offer to register the server with your coding agent. pi is registered by writing pi's `mcp.json` entry directly (project/local scope: `<project>/.pi/mcp.json`; global scope: `$PI_CODING_AGENT_DIR` or `~/.pi/agent/mcp.json`) so pi's `exposure` / `toolExposure` profile can be applied, and every other coding agent is registered via `add-mcp`.

See the [CLI reference - MCP server section (canonical copy in OpenViking)](viking://resources/trailstep/docs/cli-reference/CLI_reference/MCP_server.md) for the tool inventory, the `mcp.perWorkflowTools` list/fallback mode, registration scopes, and MCP-related environment variables.

## Managed agent sessions

Use `trailstep` or `trailstep open` to open the first configured default target, `agents.default[0]`, as a standalone coding-agent session in the current project:

```bash
trailstep
trailstep open
```

Open a named configured agent, such as a reviewer target configured with `trailstep agents`:

```bash
trailstep open reviewer
trailstep reviewer
```

Open a registered provider shortcut ephemerally when you do not need a named config entry:

```bash
trailstep open claude
trailstep claude
```

Standalone sessions are not workflow runs and do not create workflow steps. They write generated artifacts under `.trailstep/sessions/<session-id>/`, including `session.json` and `launch-prompt.md`. The MVP launches providers through the inherited-stdio terminal backend, uses only the first configured target for an agent entry, does not capture transcripts, and does not yet provide node-pty, send-input, or multi-session management. TrailStep injects managed-session guidance as a hidden/system prompt where a provider supports it; otherwise the session metadata records the visible prompt fallback.

## Workflow refs

TrailStep accepts these workflow reference forms:

```bash
trailstep ./workflow.ts#reviewWorkflow --input-file input.json
printf '%s\n' '{"request":"review this"}' | trailstep ./workflow.ts#reviewWorkflow --input-file -
trailstep project/review
trailstep global/cleanup
trailstep @acme/workflows#release
```

Use direct refs while developing, registered refs for stable project/user workflows, and bundle refs for workflows exposed by installed packages.

## Package-backed workflows

`trailstep add` can install and register workflows from npm packages or explicit GitHub specs:

```bash
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --dry-run
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes
trailstep add github:acme/trailstep-workflows --scope project --workflow review --project-skill --yes
```

TrailStep detects the target package manager from lockfiles or the `packageManager` field and defaults to `npm` only when neither is present.

## Scopes

- `local`: private to this checkout/machine.
- `project`: shared project config; recommended for team workflows.
- `global`: user-wide config and personal workflows.

See [Scopes and config (canonical copy in OpenViking)](viking://resources/trailstep/docs/scopes-and-config/scopes-and-config.md) for details.

## Run artifacts

Workflow runs write `.trailstep/runs/<runName>/` directories for inspection and replay. Standalone managed agent sessions write `.trailstep/sessions/<session-id>/` instead and are not workflow runs. Set `TRAILSTEP_RUNS_ROOT` to override the runs root for a command/session. Treat generated artifact directories as output; do not manually edit them to recover workflow state.
