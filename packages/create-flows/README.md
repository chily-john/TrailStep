# @trailstep/create-flows

`@trailstep/create-flows` is a public package of reusable, general-purpose TrailStep workflows.

## Install

```bash
pnpm add @trailstep/create-flows @trailstep/authoring
pnpm add -D @trailstep/cli
```

## Workflows

- `takeItAway`: turns an existing conversation or feature request into reviewed planning and story-by-story delivery.
- `grillItAway`: starts with an interactive conversation and then runs the same implementation pipeline.

## Usage

```json
{
  "conversation": "We need a workflow that exports widget reports..."
}
```

```bash
trailstep add @trailstep/create-flows#takeItAway
trailstep @trailstep/create-flows#takeItAway --input-file feature-request.json
trailstep @trailstep/create-flows#grillItAway
trailstep retry @trailstep/create-flows#takeItAway <runName>
```

Generated run artifacts live under `.trailstep/runs`; inspect them, but do not edit them to recover workflow state.
