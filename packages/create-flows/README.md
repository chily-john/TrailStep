# @stepkit/create-flows

Personal collection of StepKit workflows.

## Workflows

- `dailyNote`: writes a short text file into the run directory, then completes.
- `takeItAway`: turns a conversation/feature request into a reviewed `feature-doc.md` and `implementation-doc.md`, splits the plan into stories, then implements and reviews each story one at a time with bounded retries. Its steps and prompt fragments live under `src/feature-implementation/`, shared by any workflow that needs the same feature-doc/implementation-doc/story pipeline.
- `grillItAway`: opens an interactive front-door conversation with no required input, grills the user until it understands the feature request, then runs the same reviewed `feature-implementation` pipeline `takeItAway` uses.

## Local source testing

For unpublished development in this monorepo, register or run the TypeScript source directly so prompt fragments are read from `src/` beside their callers:

```bash
stepkit add ./packages/create-flows/src/index.ts#takeItAway
stepkit add ./packages/create-flows/src/index.ts --workflow takeItAway
stepkit add ./packages/create-flows/src/index.ts --workflow '*'
stepkit project/take-it-away
```

Direct refs use `path#exportName` when the file or directory exports more than one workflow.

## Built or published package use

Use bundle/package manifest refs only after the package build preserves the source directory layout expected by `loadFragments(import.meta.dirname, ...)` and copies the non-TypeScript `.md` prompt fragments into `dist/`:

```bash
stepkit add @stepkit/create-flows#takeItAway
stepkit add @stepkit/create-flows --workflow takeItAway
```
