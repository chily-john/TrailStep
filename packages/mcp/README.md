# @trailstep/mcp

TrailStep MCP server package.

Provides the MCP server entry (`src/index.ts`) and the `run_workflow` tool adapter. The server speaks MCP over stdio in the foreground and exposes TrailStep workflows, run observation, and continuation to any MCP client.

## Usage

```bash
trailstep mcp --project /some/dir
```

`trailstep mcp` (from `@trailstep/cli`) is the canonical entry: it resolves `--project` to an absolute directory, operates the server there, and serves over stdio until the client disconnects. Without `--project` the server uses its current directory. Project/local registrations pin `--project <dir>`; global registrations omit it so the server follows the agent client's cwd (layered project tools plus global `~/.trailstep` tools).

## Tool inventory

Generic toolkit (always listed):

- `trst_run_workflow` — start a workflow run in the background and return immediately with `{runId, runDir, status, workflow}` where `status` is `"started"` or `"failed"`. `"started"` is reported only after the background run's directory actually materializes (bounded verification); a run that never starts returns `status: "failed"` with an `error` and is surfaced by the server as an `isError` tool result — never a false `"started"`. The run is spawned as a detached `trailstep <workflowRef> <runName> --input <json>` process; the blocking runtime is intentionally not awaited inside the server (non-blocking run contract).
- `trst_watch` — observe a run's `events.jsonl` from a byte-offset cursor with long-polling. The cursor persists atomically at `.trailstep/mcp/.cursor/<runId>.json`; `verbosity` caps emitted lines at 50 (brief) / 100 (normal) / 200 (full).
- `trst_answer` — persist an answer into the run's real wait answer file (atomic tmp + rename), optionally continuing the run with `continueAfterAnswer`.
- `trst_resume` — continue a waiting run through the real `trailstep continue` path and report the continue status.

Per-workflow tools (the default, `mcp.perWorkflowTools: true`): every generated `.trailstep/mcp/trst_<id>.json` is listed as its own `trst_<id>` tool. The tool's `inputSchema` comes from the workflow's input shape, and dispatch presets the JSON's `workflowRef` so a caller cannot redirect the run — the call's arguments are the workflow input. Generic tool names are reserved; a per-workflow JSON that collides with one is skipped.

Fallback (`mcp.perWorkflowTools: false`): the per-workflow tools are replaced by a single `trst_list` discovery tool that returns `{name, description}` for each generated workflow tool, alongside the generic toolkit above.

The server performs no regeneration: the tool JSONs and the mode flag are re-read fresh on every ListTools/CallTool request.

## Generated tool artifacts

- `trailstep add` writes `.trailstep/mcp/trst_<id>.json` for each added workflow.
- Any `trailstep update` that covers workflows (`--workflows`, `--workflow`, `--all`) rewrites the JSONs for every registered workflow.
- No other command regenerates them. Each write is structurally validated and atomic (tmp file + rename in the same directory); per-registration resolution failures are reported without aborting the rest. Do not hand-edit generated `.trailstep/mcp` artifacts.

`mcp.perWorkflowTools` lives in the layered TrailStep config (`~/.trailstep/config.json` < `.trailstep/config.json` < `.trailstep/config-local.json`), defaults to `true`, and malformed values warn on stderr and fall back to the default.

## Registration

`trailstep init` and `trailstep add` auto-offer registering the server with detected coding agents. Every agent except pi is registered through `add-mcp`: project/local use the server name `trailstep`, global uses `trailstep-global` (follows the client's cwd), and local appends the `.mcp.json` gitignore entry. Headless runs (`--yes`) and any spawn failure print the exact manual `npx add-mcp ...` command instead of prompting.

pi is registered by writing pi's `mcp.json` entry directly, because pi's `exposure` / `toolExposure` keys are pi-only concepts that `add-mcp` cannot express. pi is excluded from the `add-mcp` agent list so no competing entry is written into the user-level file.

| Scope | pi config file | Server name |
| --- | --- | --- |
| project | `<projectDir>/.pi/mcp.json` | `trailstep` |
| local | `<projectDir>/.pi/mcp.json` (same path as project) | `trailstep` |
| global | `<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/mcp.json` | `trailstep-global` |

The written entry carries `exposure: "codemode"` for the whole server plus a `toolExposure` override that makes the generic run-loop tools (`trst_run_workflow`, `trst_watch`, `trst_answer`, `trst_resume`) `direct`, so the model can call them without a codemode script while the large-schema per-workflow `trst_*` tools stay `codemode`. The write is atomic (temp file + rename in the same directory), preserves other servers and unknown top-level keys such as `autoEnableCodemode`, and never clobbers an existing entry that is configured differently. A failed write never fails the run: it warns and prints the manual `pi mcp add <name> -- <command> <args...>` command instead.

Note that a pi project entry that carries a `command` replaces the same-named user-level entry for that project (only `enabled` / `exposure` / `toolExposure` merge between the two), which is what the project-scope entry intends.

## Resources

- `trailstep://project` — the resolved project directory as JSON.
- `trailstep://instructions` — markdown instructions: the project's `.trailstep/mcp/instructions.md` when present, else an embedded generic fallback with the static watch/answer/resume tool-mapping snippet.

## Environment

- `TRAILSTEP_RUNS_ROOT` — overrides the runs root for run resolution and background run placement (resolved against the run cwd; default `<cwd>/.trailstep/runs`).
- `TRAILSTEP_CLI_ENTRY` — absolute path of the `@trailstep/cli` entry used to spawn background runs and continues; falls back to the running process when it is the CLI, then (non-Windows only) to `trailstep` on PATH. On win32 the PATH fallback is refused (cmd.exe would mangle the `--input` JSON), so Windows callers must set this variable or `trst_run_workflow` reports `status: "failed"`.

## Tests

Tests live in `test/` (this package keeps tests out of `src/`) and are built on the `@trailstep/trailtest` helpers.
