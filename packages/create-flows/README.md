# @stepkit/create-flows

`@stepkit/create-flows` is a public package of reusable, general-purpose StepKit workflows. Install it in any project where you run StepKit when you want ready-made workflow automation for turning feature conversations into reviewed implementation plans and story-by-story delivery.

## Install

```bash
pnpm add @stepkit/create-flows @stepkit/authoring
pnpm add -D @stepkit/cli
```

Initialize StepKit configuration if the consuming project has not already done so:

```bash
stepkit init
```

You can install the packaged StepKit usage skill during init with `--install-skill`, or skip it with `--no-install-skill`.

## Register workflows

Register one workflow:

```bash
stepkit add @stepkit/create-flows --workflow takeItAway
stepkit add @stepkit/create-flows --workflow grillItAway
```

Or use bundle refs directly:

```bash
stepkit @stepkit/create-flows#takeItAway --input-file feature-request.json
stepkit @stepkit/create-flows#grillItAway
```

## Workflows

- `takeItAway`: turns an existing conversation or feature request into a reviewed `feature-doc.md` and `implementation-doc.md`, splits the plan into stories, then implements and reviews each story one at a time with bounded retries.
- `grillItAway`: starts with an interactive conversation, asks follow-up questions until the feature request is understood, then runs the same reviewed feature-documentation, planning, implementation, and review pipeline used by `takeItAway`.

## Inputs

`takeItAway` expects a JSON object with a `conversation` string:

```json
{
  "conversation": "We need a workflow that exports widget reports..."
}
```

`grillItAway` can start with `{}`. It opens an interactive StepKit agent session and produces the conversation transcript that feeds the shared feature-implementation pipeline.

## Interactive completion and retry

Interactive steps complete with `stepkit continue` from the launched agent process. If a run fails or is interrupted, use StepKit retry support for the latest unresolved failure:

```bash
stepkit retry @stepkit/create-flows#takeItAway <runName>
```

Do not edit `.stepkit/runs` artifacts to recover a workflow. Run directories are generated runtime outputs for inspection; use `stepkit retry` or start a fresh run when recovery is unclear.
