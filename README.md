# StepKit

StepKit is a durable, typed, observable workflow harness for coding agents. It lets teams author workflows in TypeScript, run them locally through a continuation runtime, and inspect persisted run artifacts after each execution.

## Package status

Initial public publish set:

- `@stepkit/core` — framework-neutral runtime, schema helpers, continuation execution, run artifacts, retry events, and agent/interactive step primitives.
- `@stepkit/authoring` — TypeScript authoring helpers built on core: `defineWorkflow`, `step`, `done`, shapes, prompts, and agent role declarations.
- `@stepkit/cli` — `stepkit` command for initialization, agent configuration, workflow registration/discovery, local runs, interactive continuation, retry, doctor, and update flows.
- `@stepkit/create-flows` — reusable general-purpose StepKit workflows for planning, implementing, and reviewing feature work.

Not-yet-published workspace packages:

- `@stepkit/testkit` — not part of the initial public publish set; currently internal workflow testing utilities.
- `@stepkit/dashboard` — not part of the initial public publish set; currently internal local observability UI work.

## Install

Install the packages you need in the project that will run workflows:

```bash
pnpm add @stepkit/core
pnpm add @stepkit/authoring
pnpm add -D @stepkit/cli
pnpm add @stepkit/create-flows
```

Equivalent `npm`, `yarn`, or `bun` commands work as long as the packages are installed in the consuming project. StepKit does not use an npm postinstall prompt; setup is explicit through `stepkit init`.

## Initialize StepKit and the agent skill

Create configuration interactively:

```bash
stepkit init
```

The CLI prompts for scope and agent settings when they are omitted. You can also be explicit:

```bash
stepkit init --scope project --install-skill
stepkit init --scope project --no-install-skill
```

`--install-skill` installs the packaged StepKit usage skill during init. `--no-install-skill` skips that step without prompting. There is no npm postinstall prompt.

Use `stepkit agents` later to update provider and model mappings. Workflows declare provider-neutral roles; local config maps those roles to command-backed agent targets.

## Author a workflow

New workflows should use the continuation authoring model: `defineWorkflow({ start })`, `step(...)`, and `done(...)`. Workflow inputs should be JSON object inputs.

```ts
import { defineWorkflow, done, shape, step } from "@stepkit/authoring";

export const helloWorkflow = defineWorkflow({
  id: "hello",
  agents: {
    writer: { size: "small" },
  },
  inputShape: shape({ name: "string" }),
  outputShape: shape({ greeting: "string" }),
  start(input) {
    return step({ id: "write-greeting" })
      .prompt(({ input }) => `Write a friendly greeting for ${input.name}.`, {
        output: shape({ greeting: "string" }),
        agent: "writer",
      })
      .do((output) => done(output))(input);
  },
});
```

Use workflow-level `agents` to name roles and defaults, then use step-level `agent` to choose the role for a specific agent step. Code steps can return another `step(...)` continuation or `done(...)`.

## Run workflows

The CLI accepts direct refs, registered refs, and bundle refs:

```bash
# Direct refs
stepkit ./workflows/hello.ts --input '{"name":"Ada"}'
stepkit ./workflows/index.ts#helloWorkflow hello-run --input-file input.json

# Registered refs
stepkit add ./workflows/hello.ts --scope project
stepkit project/hello --input-file input.json

# Bundle refs
stepkit add @stepkit/create-flows --workflow takeItAway
stepkit @stepkit/create-flows#takeItAway --input-file feature-request.json
```

A run name is optional when starting a run; StepKit generates one if omitted. Inputs loaded from `--input` or `--input-file` must be JSON objects.

Interactive steps complete with `stepkit continue`. Default interactive steps use:

```bash
stepkit continue --session-file session-description.md
```

Structured interactive steps can use:

```bash
stepkit continue --json-file output.json
stepkit continue --json '{"ok":true}'
```

If a run fails or is interrupted, use StepKit retry support:

```bash
stepkit retry <workflow-ref> <runName>
```

Use `stepkit retry`; do not invent separate workflow resume mechanisms. Provider-specific resume flags, when a provider supports them, are separate from StepKit workflow retry.

## Run artifacts and local files

Runs write runtime outputs under `.stepkit/runs/<runName>/`, including event streams and per-step artifacts. `.stepkit/runs` artifacts are runtime outputs and should not be manually mutated. Inspect them for observability, but recover failed work with `stepkit retry` or by starting a new run.

Local artifacts are ignored by default. Project config can be committed from `.stepkit/config.json`, while personal overrides such as `.stepkit/config-local.json`, run directories, and other generated local outputs stay out of source control.

## Public release validation

Useful local checks before a public release or documentation change:

```bash
pnpm check:public-packages
pnpm run pack:public:dry-run
node scripts/check-public-docs.mjs
node scripts/check-local-artifact-ignore.mjs
pnpm check:verification-cleanup
pnpm typecheck
pnpm lint
pnpm test
```

These checks verify public package metadata, npm pack dry-run contents for the intended public package set, npm-facing documentation, local artifact ignore rules, stale verification-script cleanup, and normal TypeScript/lint/test health.
