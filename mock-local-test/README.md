# StepKit manual local E2E fixture

This folder is intentionally ignored by git. It mimics a consuming project with an installed workflow package under `node_modules/@acme/stepkit-workflows`.

Build StepKit first from the repository root:

```bash
pnpm build
```

Then run manual checks from this folder using the built CLI:

```bash
node ../packages/cli/dist/index.js list
node ../packages/cli/dist/index.js @acme/stepkit-workflows:helloWorkflow manual-run --input-file input.json
```

Run artifacts are written to `.stepkit/runs/` inside this folder.

## Built-in provider manual checks

`@stepkit/core` ships first-party, hardcoded knowledge of how to run four specific agent CLIs — Claude, Codex, Pi, Gemini — in their non-interactive/headless "print mode" (`packages/core/src/providers/registry.ts`). Each is a real, unmodified vendor binary invoked purely from declarative `.stepkit/config.json`; `core` imports no vendor SDK library, only spawns the CLI process. Any CLI outside this set of four still works via the `customAgents` escape hatch (currently empty in this fixture — add an entry there if you want to exercise a non-built-in agent).

To keep each provider's check genuinely isolated and deterministic (no shared fallback chain, no run picking a different provider than its name implies), `node_modules/@acme/stepkit-workflows/index.mjs` exports **one workflow per provider** — `claudeWorkflow` (id `claude-greeting`), `codexWorkflow` (id `codex-greeting`), `piWorkflow` (id `pi-greeting`), `geminiWorkflow` (id `gemini-greeting`) — identical step logic, each with its own `writer` role resolved against exactly one provider target in `.stepkit/config.json`. Unlike an earlier version of this fixture, these are NOT stacked into one shared fallback array on a single workflow — each run-name below reliably exercises the provider its name says it does.

### Claude

`packages/core/src/providers/claude.ts` builds `claude -p --output-format json --dangerously-skip-permissions --model <model> --effort <level> <prompt>`, captures stdout (not inherited), extracts the final JSON object via `packages/core/src/providers/envelope.ts` (flat `"result"` field), and writes `output.json` itself.

```bash
claude --version
node ../packages/cli/dist/index.js @acme/stepkit-workflows:claudeWorkflow claude-run --input-file input.json
```

Expected: `.stepkit/runs/claude-run/events.jsonl` ends with `workflow.completed`; `.stepkit/runs/claude-run/steps/claude-greet/output.json` contains a real Claude-produced `{"greeting":"..."}`.

### Codex

`packages/core/src/providers/codex.ts` builds `codex exec --dangerously-bypass-approvals-and-sandbox -m <model> -c model_reasoning_effort="<level>" -o <outputFile> <prompt>`. Structurally different from Claude: Codex's own `-o`/`--output-last-message` flag writes `output.json` directly as a side effect of the process — no stdout capture, no `envelope.ts` involved. Codex has no `"max"` reasoning tier; passing `thinking: "max"` throws `agent_provider_thinking_unsupported` rather than guessing a mapping.

```bash
codex --version
node ../packages/cli/dist/index.js @acme/stepkit-workflows:codexWorkflow codex-run --input-file input.json
```

Expected: `.stepkit/runs/codex-run/events.jsonl` ends with `workflow.completed`; `.stepkit/runs/codex-run/steps/codex-greet/output.json` contains `{"greeting":"..."}` written directly by Codex's `-o` flag — no envelope wrapper object in the raw file.

### Pi

`packages/core/src/providers/pi.ts` builds `pi -p --model <pattern> --thinking <level> <prompt> --mode json` — no dangerous/approval-bypass flag, since Pi does not gate non-interactive `-p` runs on approval. Confirmed empirically (not doc-guessed): `pi --mode json` is **not** a flat envelope like Claude's — it prints one JSON object per line for the whole session transcript, and the final answer lives in the `"message"` field of the last `turn_end` line, itself shaped `{role, content: [{type, text}, ...]}` (an Anthropic-Messages-API-style content-block array, with a `"thinking"` block ahead of `"text"` when `--thinking` is above `"off"`). `envelope.ts` was generalized with a content-block-array extraction branch to handle this. Pi's `--thinking` vocabulary (`off|minimal|low|medium|high|xhigh|max`) is a strict superset of StepKit's `WorkflowAgentThinking` (`low|medium|high|xhigh|max`), so values pass straight through unmapped.

The configured model pattern, `openai-codex/gpt-5.5`, needs its explicit `<provider>/<model>` prefix — an unprefixed `--model gpt-5.5` was observed to resolve ambiguously and fail with "No API key found for azure-openai-responses."; run `pi --list-models` to see locally configured provider/model pairs.

```bash
pi --version
node ../packages/cli/dist/index.js @acme/stepkit-workflows:piWorkflow pi-run --input-file input.json
```

Expected: `.stepkit/runs/pi-run/events.jsonl` ends with `workflow.completed`; `.stepkit/runs/pi-run/steps/pi-greet/output.json` contains a real Pi-produced `{"greeting":"..."}`, extracted via the confirmed `"message"` field. A wrong field name would fail loudly (JSON-parse or schema-assert error), not silently.

### Gemini — least-verified, not real-CLI tested

**Gemini is not installed in this environment.** `packages/core/src/providers/gemini.ts` builds the doc-sourced `gemini -p <prompt> --yolo -m <model> --output-format json` and extracts a flat `"response"` field via `envelope.ts` — the same flat-string shape as Claude, unlike Pi's content-block shape. `thinking` is a deliberate no-op: no confirmed Gemini reasoning-effort flag exists, and the adapter does not guess one. Verified **structurally only** so far, via an injected fake `providerWorkingRunner` in `packages/core/src/agent.test.ts`/`packages/core/src/providers/gemini.test.ts` — never a live `gemini` process.

```bash
gemini --version
node ../packages/cli/dist/index.js @acme/stepkit-workflows:geminiWorkflow gemini-run --input-file input.json
```

**Required follow-up before trusting this adapter in production:** once `gemini` is installed/authenticated somewhere, run the command above for real and confirm `workflow.completed` with a genuine Gemini-produced `output.json`. Until that's done, Gemini remains the one built-in provider never exercised against its real binary.

## Custom agent escape hatch

Any CLI outside the four built-in providers is still fully supported via the top-level `customAgents` map in `.stepkit/config.json` (currently empty in this fixture) — same `{{promptFile}}`/`{{outputFile}}`/`{{model}}` placeholder templating StepKit has always used for command-backed agents. Point a role's target at `{"provider": "<your-custom-key>", ...}` where `<your-custom-key>` matches a `customAgents` entry (`{"binary": "...", "args": [...]}`), and it resolves through the exact same generic argv-template spawn path the built-in providers don't use.
