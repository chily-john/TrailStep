# @stepkit/create-flows

`@stepkit/create-flows` is a public package of reusable, general-purpose StepKit workflows. Install it anywhere you run StepKit when you want ready-made workflow automation for turning feature conversations into reviewed implementation plans and story-by-story delivery.

## Installation

Install the package with your package manager, then add one or more workflow exports to a StepKit project:

```bash
pnpm add @stepkit/create-flows
stepkit add @stepkit/create-flows#takeItAway
stepkit add @stepkit/create-flows#grillItAway
```

You can also register a named workflow from the package manifest:

```bash
stepkit add @stepkit/create-flows --workflow takeItAway
stepkit add @stepkit/create-flows --workflow grillItAway
```

Built package refs use the `package-name#exportName` form, such as `@stepkit/create-flows#takeItAway`, when a package exports more than one workflow.

## Workflows

- `takeItAway`: turns an existing conversation or feature request into a reviewed `feature-doc.md` and `implementation-doc.md`, splits the plan into stories, then implements and reviews each story one at a time with bounded retries.
- `grillItAway`: starts with an interactive conversation, asks follow-up questions until the feature request is understood, then runs the same reviewed feature-documentation, planning, implementation, and review pipeline used by `takeItAway`.

## Input expectations

### `takeItAway`

Provide a `conversation` string that contains the user request and any relevant context the workflow should transform into a feature plan.

```json
{
  "conversation": "We need a workflow that exports widget reports..."
}
```

### `grillItAway`

No structured input is required. The workflow begins by opening an interactive StepKit agent session and produces the conversation transcript that feeds the shared feature-implementation pipeline.

## Source refs vs built package refs

For package consumers, prefer built package refs after installation:

```bash
stepkit add @stepkit/create-flows#takeItAway
stepkit add @stepkit/create-flows#grillItAway
```

Repository contributors can run the TypeScript source directly while developing changes in this monorepo:

```bash
stepkit add ./packages/create-flows/src/index.ts#takeItAway
stepkit add ./packages/create-flows/src/index.ts#grillItAway
stepkit add ./packages/create-flows/src/index.ts --workflow '*'
```

Source refs use `path#exportName` when the file or directory exports more than one workflow. Built package refs use package exports from `dist/`, where build tooling inlines prompt fragments needed by the workflows.

## Run artifacts

StepKit writes workflow run outputs and observability data under `.stepkit/runs/`. Those directories are generated artifacts from executing workflows; they are not source files that need to be imported by consumers.

## Recovery guidance

If a run is interrupted, use StepKit retry support for the latest unresolved failed or interrupted step:

```bash
stepkit retry @stepkit/create-flows#takeItAway <runName>
```

When evaluating any interrupted run artifact, inspect `events.jsonl` in replay order and confirm the run still has valid active story state before retrying. Starting a fresh run is often safer when the artifact history is unclear.
