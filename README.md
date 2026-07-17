# StepKit

StepKit is a durable, typed, observable workflow harness for coding agents.

StepKit is a clean-slate project and is separate from Workflower. It defines a workflow harness direction without depending on Workflower internals.

## Current status

StepKit supports local TypeScript-authored workflows: packages define workflows with the SDK, expose them from npm-style workflow packages, discover them with the CLI, and run them through the core continuation runtime with persisted run events.

New workflow work should use the continuation model. Workflows are registered as package exports, start from `defineWorkflow({ ... start })`, invoke work through `step(...)`, return the next node from each continuation, and finish with `done(...)`.

Command-backed local agents are the default path: workflows declare roles, steps reference those roles, and users map roles and size tiers in `.stepkit/config.json`.

## Packages

- `@stepkit/core` (`packages/core`) for schema validation, continuation workflow execution, run directories, event artifacts, provider-agnostic command-agent seams, prompt rendering, structured output parsing, and interactive step orchestration.
- `@stepkit/sdk` (`packages/sdk`) for TypeScript authoring APIs such as `defineWorkflow`, workflow-level `agents`, step-level `agent`, `step`, `done`, simple shapes, and function prompts.
- `@stepkit/cli` (`packages/cli`) for `stepkit list`, package-qualified workflow discovery, JSON input loading, resume, skill checks, and local execution of registered workflow exports.
- `@stepkit/testkit` (`packages/testkit`) for workflow and step validation helpers.
- `@stepkit/dashboard` (`packages/dashboard`) for local observability and inspection surfaces over `.stepkit/runs` artifacts.

## CLI quick start

In a consuming project with a dependency whose `package.json` includes the `stepkit-workflow` keyword, export a workflow from that package. Agent steps should use workflow-level `agents` and step-level `agent`.

```ts
import { defineWorkflow, done, shape, step } from "@stepkit/sdk";

export const helloWorkflow = defineWorkflow({
  id: "hello",
  inputShape: shape({ name: "string" }),
  outputShape: shape({ greeting: "string" }),
  start(input) {
    return step({
      id: "greet",
    }).next(({ name }) => done({ greeting: `Hello, ${name}!` }))(input);
  },
});
```

A conceptual `.stepkit/config.json` maps command names, `workingAgents`, `interactiveAgents`, and workflow role bindings.

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

Implementation guidance lives in `.pi/rules/` and package `README.md` files. GitHub branch-protection guidance lives in `.github/branch-protection.md`.

Local documentation verification:

```bash
node scripts/verify-repository-docs.mjs
```
