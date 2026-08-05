# StepKit

StepKit is a durable, typed, observable workflow harness for coding agents.

StepKit is a clean-slate project and is separate from Workflower. It defines a workflow harness direction without depending on Workflower internals.

## Current status

StepKit supports local TypeScript-authored workflows: packages define workflows with the authoring package, expose them from npm-style workflow packages or direct Node-loadable workflow files, discover compatible package exports with the CLI, register convenient refs, and run workflows through the core continuation runtime with persisted run events.

New workflow work should use the continuation model. Workflows are registered as package exports, start from `defineWorkflow({ ... start })`, invoke work through `step(...)`, return the next node from each continuation, and finish with `done(...)`.

Command-backed local agents are the default path: workflows declare roles, steps reference those roles, and users map roles and size tiers in `.stepkit/config.json`.

## Packages

- `@stepkit/core` (`packages/core`) for schema validation, continuation workflow execution, conservative automatic retry for safe pre-dispatch failures, run directories, event artifacts, provider-agnostic command-agent seams, prompt rendering, structured output parsing, and interactive step orchestration.
- `@stepkit/authoring` (`packages/authoring`) for TypeScript authoring APIs such as `defineWorkflow`, workflow-level `agents`, step-level `agent`, `step`, `done`, simple shapes, and function prompts.
- `@stepkit/cli` (`packages/cli`) for direct workflow files, registered refs, bundle refs, legacy package-qualified workflow discovery, JSON input loading, manual retry, skill checks, and local execution.
- `@stepkit/testkit` (`packages/testkit`) for workflow and step validation helpers.
- `@stepkit/dashboard` (`packages/dashboard`) for local observability and inspection surfaces over `.stepkit/runs` artifacts.

## CLI quick start

In a consuming project with a dependency whose `package.json` includes the `stepkit-workflow` keyword, export a workflow from that package. Agent steps should use workflow-level `agents` and step-level `agent`.

```ts
import { defineWorkflow, done, shape, step } from "@stepkit/authoring";

export const helloWorkflow = defineWorkflow({
  id: "hello",
  inputShape: shape({ name: "string" }),
  outputShape: shape({ greeting: "string" }),
  start(input) {
    return step({
      id: "greet",
    }).do(({ name }) => done({ greeting: `Hello, ${name}!` }))(input);
  },
});
```

A conceptual `.stepkit/config.json` maps reusable `customProviders`, `agents.*.items`, and workflow role bindings.

Then run it from the consuming project using a direct local file, a registered ref, a bundle ref, or the legacy package-export form:

```bash
stepkit init
stepkit agents
stepkit ./workflows/hello.mjs --input-file input.json
stepkit ./workflows/hello.mjs hello-run --input-file input.json
stepkit project/hello
stepkit user/cleanup
stepkit @acme/workflows#hello
stepkit retry <workflow-ref> hello-run
```

Run names are optional when starting a run; StepKit generates one if omitted. `stepkit retry` reruns from the latest unresolved failure in an existing `.stepkit/runs/<workflowRunName>` directory. Automatic retry is conservative and limited to safe pre-dispatch failures; use `maxAttempts: 1` on the effective retry policy to disable it. `stepkit workflows` reports registered refs grouped by scope and then legacy package export discovery.

Runs create `.stepkit/runs/<actualRunName>/` in the consuming project. Events are written to `.stepkit/runs/<actualRunName>/events.jsonl`.

Interactive steps use a file-based completion protocol. StepKit writes `interactive.json` and waits for the launched agent to run `stepkit continue`. Default interactive steps ask the agent to write a dense `session-description.md` and continue with `stepkit continue --session-file session-description.md`; structured interactive steps continue with `stepkit continue --json-file output.json` or `stepkit continue --json '{...}'`. When an agent receives the prompt directly, no `prompt.txt` artifact is created; `prompt.txt` exists only for commands configured with `{{promptFile}}`. Interactive steps now complete through `stepkit continue` and no longer return an opaque `{ exitCode }` object by default.

## Setup

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Use Node 24 or newer. The intended remote is `git@github-personal:chily-john/stepkit.git`.

## Documentation and release readiness

Implementation guidance lives in `.pi/rules/` and package `README.md` files. GitHub branch-protection guidance lives in `.github/branch-protection.md`.

Public release readiness checks focus on package metadata and generated local artifact exclusions:

```bash
pnpm check:public-packages
node scripts/check-local-artifact-ignore.mjs
```
