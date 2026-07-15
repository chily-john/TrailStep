# Architecture direction

StepKit is a clean-slate product and architecture direction, separate from Workflower. It should borrow lessons from existing agent workflow tools without inheriting their package boundaries, command model, runtime state shape, or prompt-rendering behavior.

## Product shape

StepKit is a durable, typed, observable workflow harness for coding agents. It helps maintainers publish workflow packages that agents can discover, run, validate, and inspect across local and CI environments.

## v0 workflow model

The v0 architecture is a continuation model, not the obsolete static `steps: []` direction. A package author exports workflows as registration and CLI discovery entry points. Each workflow is declared with `defineWorkflow({ id, inputShape, outputShape, start })`; the `start` function receives validated workflow input and returns the first node.

`step(...)` is the only user-facing step primitive for new workflows. A step node contains its live input, an output shape, and either code execution or prompt/agent configuration. When the step completes, its continuation returns the next `step(...)` node or `done(output)`. Error continuations may return an alternate next node or `done(...)` with failure-shaped output. This keeps branching and recovery in TypeScript orchestration code instead of in hidden runtime state.

## Package boundaries

The first package set is `core`, `sdk`, `cli`, `testkit`, and `dashboard`. `core`, `sdk`, and `cli` carry the implemented v0 vertical slice; `testkit` and `dashboard` remain publish-ready scaffolds.

- `core` owns provider-agnostic runtime primitives: framework-neutral types, the continuation engine, shape/schema validation, prompt wrapping, structured output parsing, events, run artifacts, provider-neutral command-agent execution seams, and a small built-in provider registry for known-CLI print-mode invocation (Claude, Codex, Pi, Gemini). `core` imports no vendor SDK library.
- `sdk` owns ergonomic TypeScript authoring helpers layered thinly over `core`: `defineWorkflow`, workflow-level `agents`, step-level `agent`, `step`, `done`, and shape re-exports.
- `cli` owns user-facing commands, package discovery of exported workflows from packages marked with the `stepkit-workflow` keyword, and loading local `.stepkit/config.json` for role/size-tier resolution.
- `testkit` owns future behavior-focused validation utilities.
- `dashboard` owns future inspection and observability surfaces.

This split is a durable decision, not just current file layout: `core` must stay framework-neutral and CLI/UI-free, `sdk` must stay a thin authoring layer rather than reimplementing runtime semantics, and `cli` must stay a thin shell around discovery/config/input loading plus `core` execution. For current per-package implementation detail, enter `.pi/rules/packages/`.

## Agent execution direction

StepKit's v0 agent architecture is provider-agnostic at the workflow-authoring layer. Workflow authors name roles such as `implementer` or `reviewer`; users map those roles and size tiers to targets in `.stepkit/config.json`, with separate `workingAgents` and `interactiveAgents` sections. Most targets are command-backed local agents that are entirely user-owned local config — any executable the user has installed, registered under `customAgents`. The one deliberate exception: `core` owns first-party knowledge of four named vendor CLIs (Claude, Codex, Pi, Gemini) through a built-in provider registry, so a target with `{"provider":"claude"}` resolves to a core-owned known-CLI print-mode invocation with no `customAgents` entry at all. This is core-owned CLI-invocation knowledge, not a baked-in vendor SDK adapter.

In-process SDK adapters — including a possible future Claude SDK library integration — are deliberately kept out of `core` and remain future optional adapter-package territory, distinct from the known-CLI print-mode invocation above, which stays entirely process-spawning. The old direction where `core` carried provider SDK adapter internals has been migrated away and should not guide new work.

## Human-in-the-loop direction

Two distinct flavors of human-in-the-loop exist and are not interchangeable:

- **Flavor B — interactive session handoff**: a human takes over a real interactive CLI session directly, no agent adapter/SDK loop involved. Built in v0.
- **Flavor A — approval interrupt**: an automated agent run pauses mid-execution for a human to approve, edit, or reject a proposed action, then resumes the same run. The event-type shape is reserved so this can be added later without a breaking type change, but the pause/resume mechanics are not implemented in v0.

## Preserved decisions

- TypeScript is the first-class authoring/runtime language.
- The first package set is `core`, `sdk`, `cli`, `testkit`, and `dashboard`.
- Workflows, not individual steps, are public command/discovery units.
- Step invocations should use typed object input.
- Prompt rendering should be deterministic from step input.
- Runtime state access belongs in orchestration/code steps, not hidden in prompt rendering.
- Observability/dashboard should be considered early.
- CLI/discovery/npm package distribution are expected primary integration paths.

## Where to look next

- `.pi/rules/` for current, authoritative per-package implementation detail — trust it over this document when they disagree.
- Package `README.md` files for authoring examples (`packages/core/README.md`, `packages/sdk/README.md`, `packages/cli/README.md`).
- [Roadmap](roadmap.md) for what's built, what's next, resolved decisions, and open questions.
