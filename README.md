# StepKit

StepKit is a durable, typed, observable workflow harness for coding agents.

StepKit is a clean-slate project and is separate from Workflower. It exists to define the next workflow harness direction without depending on Workflower internals or compatibility constraints.

## Current status

The v0 vertical slice is implemented for local TypeScript-authored workflows: packages define workflows with the SDK, expose them from npm-style workflow packages, discover them with the CLI, and run them through the core continuation runtime with persisted run events.

New v0 work should not target the older static `steps: []` model. Workflows are registered as package exports, start from `defineWorkflow({ ... start })`, invoke work through `step(...)`, return the next node from each continuation, and finish with `done(...)`.

`@stepkit/testkit` and `@stepkit/dashboard` remain publish-ready scaffold packages. Command-backed local agents are the v0 default path: workflows declare roles, steps reference those roles, and users map roles and size tiers in `.stepkit/config.json`. SDK adapters, including Claude SDK integration, are future optional adapter-package territory rather than core internals. Approval interrupts, full config hardening, testkit helpers, and dashboard product behavior are still future work.

## Packages

The first package set is:

- `@stepkit/core` (`packages/core`) for schema validation, continuation workflow execution, run directories, event artifacts, provider-agnostic command-agent seams, prompt rendering, structured output parsing, and interactive step orchestration.
- `@stepkit/sdk` (`packages/sdk`) for first-class TypeScript authoring APIs such as `defineWorkflow`, workflow-level `agents`, step-level `agent`, `step`, `done`, simple shapes, and function prompts.
- `@stepkit/cli` (`packages/cli`) for `stepkit list`, package-qualified workflow discovery, JSON input loading, and local execution of registered workflow exports.
- `@stepkit/testkit` (`packages/testkit`) for future workflow and step validation helpers; currently scaffolded.
- `@stepkit/dashboard` (`packages/dashboard`) for future observability and inspection surfaces; currently scaffolded.

## CLI quick start

In a consuming project with a dependency whose `package.json` includes the `stepkit-workflow` keyword, export a workflow from that package. Code-step examples may use the current `run` function compatibility path for local TypeScript execution; agent steps should use workflow-level `agents` and step-level `agent`.

```ts
import { defineWorkflow, done, shape, step } from "@stepkit/sdk";

export const helloWorkflow = defineWorkflow({
  id: "hello",
  inputShape: shape({ name: "string" }),
  outputShape: shape({ greeting: "string" }),
  start(input) {
    return step(
      {
        id: "greet",
        input,
        outputShape: shape({ greeting: "string" }),
        run: ({ name }) => ({ greeting: `Hello, ${name}!` }),
      },
      (output) => done(output),
    );
  },
});
```

Agent workflows are resolved from user-owned local config. A conceptual `.stepkit/config.json` maps command names, `workingAgents`, `interactiveAgents`, and workflow role bindings.

Then discover and run it from the consuming project:

```bash
stepkit list
stepkit <package:workflowExport> <workflowRunName> --input-file input.json
```

Runs create `.stepkit/runs/<actualRunName>/` in the consuming project. Events are written to `.stepkit/runs/<actualRunName>/events.jsonl`.

## Setup

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Use Node 24 or newer. The intended remote is `git@github-personal:chily-john/stepkit.git`.

## Documentation

Start here for product and implementation direction:

- [Architecture direction](docs/architecture.md)
- [Roadmap](docs/roadmap.md)

Implementation detail lives in `.pi/rules/` and package `README.md` files, not in `docs/`. GitHub branch-protection guidance lives in `.github/branch-protection.md`.

Local documentation verification:

```bash
node scripts/verify-repository-docs.mjs
```
