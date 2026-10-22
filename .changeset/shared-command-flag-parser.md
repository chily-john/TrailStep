---
"@trailstep/authoring": minor
"@trailstep/cli": patch
"@trailstep/create-flows": patch
"@trailstep/sub-agents": patch
---

Share the remaining duplicated helpers.

`@trailstep/authoring`: exports the canonical `nonEmptyOptional` and
`nonEmptyOrDefault` string helpers (`packages/authoring/src/strings.ts`) so that
workflow packages share one "trim, then drop empty" definition.

`@trailstep/cli`: the six per-command `parseFlags` copies (`add`, `agents`,
`init`, `mcp`, `providers`, `remove`) now share one shape-driven parser
(`packages/cli/src/internals/command-framework/flags.ts`). Each command keeps
parsing exactly what it parsed before — same accepted flags, same error
messages, same empty-value and missing-value handling — and the shared
`agent_targets_unavailable` guard now lives in one place
(`packages/cli/src/internals/agent-config/agent-targets-error.ts`) used by both
the `add` and `agents` commands.

`@trailstep/create-flows`, `@trailstep/sub-agents`: the duplicated
`nonEmptyOptional` helper is imported from `@trailstep/authoring`, and the
worktree input subschema is declared once
(`delegateWorktreeInputShape` in `packages/sub-agents/src/delegate/schema.ts`)
and reused by the delegate and delegate-parallel input shapes.

This is a behavior-preserving refactor: no public workflow shape, CLI flag
behavior, or runtime behavior changed.
