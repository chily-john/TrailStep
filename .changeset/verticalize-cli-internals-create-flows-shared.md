---
"@trailstep/cli": patch
"@trailstep/create-flows": patch
---

Verticalize the CLI internals and the create-flows shared directory.

`@trailstep/cli`: the loose `packages/cli/src/internals/` root files that formed
one concern now live in `packages/cli/src/internals/command-framework/`
(`command.types.ts`, `command.types.test.ts`, `command-registry.ts`,
`command-registry.test.ts`), and `official-provider-specs.ts` was folded into
`packages/cli/src/internals/providers/official-providers.ts` alongside the
existing official-provider package helpers. Every importer was updated.

`@trailstep/create-flows`: the misnamed `src/feature-implementation/shared/`
directory was split. The cross-flow contracts imported by the sibling
`grill-it-away` and `take-it-away` flows (`agent-roles.ts`, `input-schema.ts`,
`output-schema.ts`, `constants.ts`) moved to package level at
`packages/create-flows/src/shared/`. The feature-implementation-only files
(`story-state.ts`, `story-view.ts`, `review-schema.ts`) stayed inside
`packages/create-flows/src/feature-implementation/shared/story/`, and the prompt
fragment markdown files moved to
`packages/create-flows/src/feature-implementation/prompts/`.

This is a behavior-preserving refactor: no public export, workflow shape, or
runtime behavior changed.
