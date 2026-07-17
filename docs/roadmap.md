# Roadmap

StepKit is a clean-slate workflow harness separate from Workflower. This roadmap tracks what's implemented, what's next, and which product choices are still open. For current implementation detail, `.pi/rules/` and the living source/tests are authoritative over this document.

## v0 status: implemented

- **Core workflow model**: types for workflows, continuation nodes, steps, typed object input/output, results, failures, and events.
- **SDK authoring API**: `defineWorkflow({ id, agents, inputShape, outputShape, start })`, `step(...)`, `done(...)`, deterministic prompt rendering from step input.
- **CLI discovery and execution**: `stepkit list` and `stepkit <package:workflowExport> <workflowRunName>` discover workflow packages, load `.stepkit/config.json`, and run workflows as public command units.
- **Durable runtime**: continuation interpretation, code/agent/interactive step execution, command-backed local agents, event emission, run artifacts under `.stepkit/runs/<runName>/`.
- **Config-driven agent targeting**: role -> size -> default precedence is implemented (workflow role mapping, then mode-wide role size mapping, then mode-wide `default` mapping); size keys are `default`, `tiny`, `small`, `medium`, `large`, `xl`; thinking values are `low`, `medium`, `high`, `xhigh`, `max`. `workingAgents` and `interactiveAgents` are separate maps.
- **Built-in provider registry**: Claude, Codex, and Pi are verified against a real, installed CLI binary. Gemini is verified structurally only (fake process runner in tests) since `gemini` is not installed in any environment this project has run in — a real-CLI smoke test (see `mock-local-test/README.md`) remains a required, unmet follow-up.
- **Maximum-step guard**: implemented and configurable, to catch accidental infinite continuations. Whether to expand it into richer policy is still open; the guard's existence is not.
- **Command templates**: the placeholder set is `{{prompt}}`, `{{promptFile}}`, `{{model}}` for interactive agents, and `{{promptFile}}`, `{{outputFile}}`, `{{model}}` for working agents — all whole argv values, spawned without a shell.
- **Human-in-the-loop, flavor B**: interactive session handoff (a human works directly in a spawned interactive CLI).

`testkit` and `dashboard` stay scaffolded until v0 runs end-to-end.

## What's next

1. Testkit: behavioral helpers for validating workflows, prompt rendering, runtime events, and failure paths.
2. Dashboard: early observability for workflow runs, events, prompts, state transitions, and human-in-the-loop points.
3. Repository hardening: release automation, documentation verification, branch protection, CODEOWNER review, and all-package CI until touched-package builds are designed.

## Preserved decisions

- TypeScript is the first-class authoring/runtime language.
- The first package set is `core`, `sdk`, `cli`, `testkit`, and `dashboard`. In-process provider SDK adapters are not core internals; optional adapter packages may be considered later — see Adapter strategy below.
- Workflows, not individual steps, are public command/discovery units.
- Step invocations should use typed object input.
- Prompt rendering should be deterministic from step input.
- Runtime state access belongs in orchestration/code steps, not hidden in prompt rendering.
- Observability/dashboard should be considered early.
- CLI/discovery/npm package distribution are expected primary integration paths.

## Resolved decisions (v0)

- **SDK authoring shape / SDK overloads**: `defineWorkflow` uses a single explicit object form with a `start` function, and workflows compose with the unified `step(...)` and `done(...)` primitives — no positional-argument overloads and no static step-list direction for new work.
- **Agent abstraction**: workflows declare named roles with workflow-level `agents`; steps reference one role with step-level `agent`; users map roles and size tiers to command-backed local agents in `.stepkit/config.json`. `core` owns provider-agnostic command execution, prompt wrapping, structured output parsing, failure reporting, events, and artifacts.
- **Prompt syntax**: steps declare `prompt` as inline markdown or as a function of `{ input }`. Function prompts render from live step input at runtime; local prompt-file compatibility remains only where legacy helpers require it.
- **Workflow discovery shape (v0)**: local-only for v0 — the CLI scans the consuming project's own direct dependencies for a `stepkit-workflow` package.json keyword and imports matching named exports. Real npm-registry-specific concerns (multiple installed versions, registry metadata beyond the keyword) remain unaddressed until publishing is in scope.
- **Adapter strategy**: command-backed agents are the v0 default, resolved through `core`'s built-in provider registry for four named vendor CLIs (Claude, Codex, Pi, Gemini), with `customAgents` as the escape hatch for anything else. New work should still treat in-process SDK adapters, including a Claude SDK library integration, as future optional adapter-package territory — distinct from the known-CLI print-mode invocation `core` now owns directly. How optional adapters get tested is still open, deferred alongside `testkit`.
- **Parallelization**: deferred for v0. The runtime executes steps sequentially only; no concurrent-step state/conflict model is built yet.
- **Runtime event log format (v0)**: a first-draft canonical event envelope is locked (`{ id, runId, workflowId, stepId, type, timestamp, schemaVersion, payload }`) with v0 event types covering workflow/step lifecycle, agent tool calls, and interactive sessions. Persistence, redaction, and long-term compatibility guarantees remain open.
- **Human-in-the-loop (partial)**: flavor B (interactive session handoff) is in v0 scope; flavor A (approval/edit interrupts inside an automated agent run) has its type/event shape reserved (`approval.requested` / `approval.resolved`) but is not implemented in v0.

## Migration notes

- Migration path: `requirements` -> workflow-level `agents` plus step-level `agent`. A step-local `requirements: { size: "small" }` selector becomes `defineWorkflow({ agents: { writer: { size: "small" } }, ... })` plus `step({ agent: "writer", ... })`. `requirements` has been removed entirely; there is no inline fallback, so every agent role must be declared via workflow-level `agents`.
- Claude SDK integration is no longer a core-owned adapter path. `core` imports no in-process Claude SDK library. Claude-backed execution now has two paths: `{"provider":"claude"}` resolves through `core`'s built-in provider registry as a known-CLI print-mode invocation (no `customAgents` entry needed), and any other Claude-flavored command remains configurable as a user-owned `customAgents` entry, or could be provided later by an optional adapter package outside `@stepkit/core`.

## Open questions

- Duplicate step ids: what validation and error behavior should duplicate ids have?
- Human-in-the-loop flavor A: what are the concrete pause/resume mechanics for an approval interrupt inside an automated run?
- Adapter testing: how are first-party and community agent adapters validated, once `testkit` work resumes?
- Runtime event log: persistence, redaction, and cross-version payload compatibility guarantees beyond the v0 schema draft.
- Event redaction and optional future SDK adapter details remain open beyond the v0 command-agent runtime seams.
