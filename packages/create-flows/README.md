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

## take-it-away recovery note

Do not blindly retry pre-fix corrupted take-it-away run artifacts. Historical runs may have lost active story state, missing step failure metadata, duplicate event ids, or a misleading review baseline. Event ids are opaque; inspect `events.jsonl` in replay order when evaluating an artifact.

For the investigated failed run `.stepkit/runs/take-it-away-20260804-133215-41575ba3`, prefer starting a fresh `takeItAway` run instead of retrying the artifact. That run is from the pre-fix window, so a retry is safe only if inspection proves it still contains a durable active story, valid latest retry target metadata, and no misleading review baseline. Without that proof, a fresh run avoids continuing from corrupted state.

After the durability fixes, `stepkit retry <workflow-ref> <runName>` can recover the latest unresolved failed or interrupted step, including dangling `step.started` events and step-originated workflow `fail(...)` failures. Keep workflow-level `--resume` out of take-it-away recovery procedures; use `stepkit retry` for StepKit runs.

## Built or published package use

Use bundle/package manifest refs after the package build inlines `.md` prompt fragments with the `tsup` text loader:

```bash
stepkit add @stepkit/create-flows#takeItAway
stepkit add @stepkit/create-flows --workflow takeItAway
```
