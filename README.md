# TrailStep

TrailStep is a durable, typed, observable workflow harness for coding agents. Workflows are authored in TypeScript, can pause for interactive continuation, can be retried from failed runs, and leave local artifacts you can inspect.

## Quick start

Install the CLI globally if you want a `trailstep` command everywhere:

```bash
npm install --global @trailstep/cli
trailstep init --scope project --install-skill
```

Or keep the CLI project-local and run it through your package manager:

```bash
npm install --save-dev @trailstep/cli
npx trailstep init --scope project --install-skill
```

Use whatever JavaScript package manager your project already uses. The examples use `npm` because it is the broadest default; `pnpm`, `yarn`, and `bun` equivalents work too. TrailStep's package-backed workflow commands detect the target project's lockfile or `packageManager` field and default to `npm` only when neither is present.

## Packages

Public packages:

- `@trailstep/core` — framework-neutral runtime primitives, validation, events, retry state, and run artifacts.
- `@trailstep/authoring` — TypeScript workflow authoring helpers such as `defineWorkflow`, `step`, and `done`.
- `@trailstep/cli` — the `trailstep` command.
- `@trailstep/create-flows` — reusable workflow automation (`takeItAway` and `grillItAway`).

## Author a workflow

Install authoring/runtime packages in the project that owns your workflow source:

```bash
npm install @trailstep/authoring @trailstep/core
```

Example workflow source:

```ts
import { defineWorkflow, done, shape, step } from "@trailstep/authoring";

type HelloInput = { topic: string };
type HelloOutput = { message: string };

export const hello = defineWorkflow<HelloInput, HelloOutput>({
  id: "hello",
  description: "A tiny TrailStep workflow.",
  inputShape: shape<HelloInput>({ topic: "string" }),
  outputShape: shape<HelloOutput>({ message: "string" }),
  start(input) {
    return step({ id: "echo" })
      .prompt<HelloInput, HelloOutput>(
        ({ input: stepInput }) => `Write a friendly one-sentence greeting about ${stepInput.topic}.`,
        { output: shape<HelloOutput>({ message: "string" }) },
      )
      .do((output) => done(output))(input);
  },
});
```

Run workflows with JSON object input:

```bash
trailstep ./workflows/hello.ts#hello --input '{"topic":"Reddit"}'
```

Reference forms:

- Direct refs: `trailstep ./workflows/review.ts#review --input-file input.json`
- Registered refs: `trailstep project/review`
- Bundle refs: `trailstep @acme/workflows#review`

## CLI essentials

```bash
trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]
trailstep agents
trailstep agents set <name> --provider <provider> [--model <model>] [--thinking <level>] --scope <local|project|global>
trailstep agents delete <name> --scope <local|project|global>
trailstep agents rename <old> <new> --scope <local|project|global>
trailstep add <workflow-file-bundle-or-package> [--scope <local|project|global>] [--namespace <namespace>] [--name <name>] [--workflow <workflow>] [--project-skill] [--user-skill] [--force] [--yes] [--dry-run]
trailstep remove <namespace>/<name> [--scope <local|project|global>]
trailstep workflows
trailstep <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]
trailstep continue [--interactive-file <path> | --session-file <path> | --json-file <path> | --json '<json>']
trailstep cancel [--reason '<text>']
trailstep retry <workflow-ref> <runName>
trailstep runs
trailstep doctor
trailstep update [--all | --project | --workflows | --workflow <name>] [--force] [--yes | --assume-yes]
```

`trailstep init` writes `.trailstep/config.json` style configuration. Use `--install-skill` to install the packaged TrailStep usage skill, or `--no-install-skill` to skip it. There is no npm postinstall prompt.

Configure agents with the canonical `trailstep agents` editor, or set one directly:

```bash
trailstep agents set default --provider pi [--model <model>] [--thinking <level>] --scope project
```

`--model` is a model override and `--thinking` is a reasoning/thinking override. Omit either one to use provider defaults; interactive prompts label that choice `Use provider default`. Thinking availability is provider-aware: Pi and Claude expose TrailStep-supported levels, Codex has no `max` tier, and Gemini thinking support is not configured until a confirmed flag exists. Pi model discovery is best-effort and only offers discovered choices when available; TrailStep does not maintain a hardcoded model catalog.

Custom provider args can use `{{promptFile}}`, `{{outputFile}}`, `{{model}}`, and `{{thinking}}`; interactive args may also use `{{prompt}}` for inline prompt input. Guard optional overrides with `{{#model}} ... {{/model}}` and `{{#thinking}} ... {{/thinking}}` so provider defaults omit those argv values cleanly.

## Use reusable workflow packages

`trailstep add` can register direct local refs or package-backed workflows from versioned npm package specs (for example, `@trailstep/create-flows@latest`) and explicit `github:<owner>/<repo>` specs. Package-backed adds install into the selected scope root, discover workflows, and store package metadata with each registration.

```bash
# Preview without installing, registering, or writing skills.
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --dry-run

# Install/register both public create-flows workflows in this project.
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --yes

# Run the registered workflow ids.
trailstep project/take-it-away --input-file feature-request.json
trailstep project/grill-it-away
```

By default, registrations use the workflow ids published by the package, such as `take-it-away` and `grill-it-away`. You can override a single registration with `--name <name>` and choose a different namespace with `--namespace <namespace>`, but the default ids are the recommended path for examples, support, and repeatability.

Use `--dry-run` on package-backed adds to inspect the plan without installing, registering, or writing skills. Scope controls where packages live: local/project installs use the current project root, while global installs use `~/.trailstep/packages`.

`trailstep remove` deletes the registration and only uninstalls orphaned TrailStep-owned package installs; user-owned installs, still-referenced packages, and missing or stale metadata are preserved. If cleanup fails, the registration remains removed and the command reports the package root for manual cleanup.

Use bare `trailstep update` to update the globally installed TrailStep CLI binary, `trailstep update --project` to explicitly update this project's TrailStep package dependencies, `trailstep update --workflows` to update registered npm-backed workflow packages, `trailstep update --workflow <name>` for one workflow package target, or `trailstep update --all` to combine global CLI, project TrailStep package, and workflow package updates across project/global roots. Updates prompt before writing unless `--yes` or `--assume-yes` is passed. Local-file refs are not package update targets, missing/stale metadata is skipped or rejected before mutation, and GitHub-sourced workflow package updates are not supported yet. Global CLI updates automatically refresh tracked installs of the packaged TrailStep usage skill when possible.

## Artifacts and validation

Run artifacts live under `.trailstep/runs` by default and should not be manually mutated. Set `TRAILSTEP_RUNS_ROOT` to store run artifacts somewhere else for a command/session.

Useful contributor checks:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:public-packages
pnpm run pack:public:dry-run
node scripts/check-local-artifact-ignore.mjs
```

This repository itself is a pnpm workspace and requires Node 24 or newer.
