---
"@trailstep/core": patch
"@trailstep/mcp": patch
"@trailstep/sub-agents": patch
"@trailstep/cli": patch
---

Coerce stringified workflow input scalars and enrich the MCP tool descriptions.

`@trailstep/core`: workflow input is now coerced against the workflow's own
input schema before validation. A string that unambiguously matches the
declared scalar type becomes that type -- a plain decimal becomes a `number`
or `integer`, and exactly `true` / `false` becomes a `boolean` -- including in
nested object properties and array items. Ambiguous strings (`"abc"`,
`"25abc"`, `"1e5"`, `" 25 "`, `"yes"`) and schemas without a declared type are
left untouched, so a genuinely invalid input still fails with the same
`validation_failed` diagnostics. The coercion is opt-in at the workflow-input
call site; the shared `jsonSchema()` / `assert()` validators used for agent
step outputs and documents are unchanged. The coerced value is what the run
persists, so a replayed or resumed run validates the same value.

`@trailstep/mcp`: the `trst_run_workflow` description now says that a
per-workflow tool (for example `trst_delegate` or `trst_take-it-away`) should
be preferred when one exists, and the `trst_watch` description now says that
the byte-offset cursor is persisted per run, that an unknown run id returns an
error result instead of waiting, and how it pairs with `trst_run_workflow` and
`trst_answer`. The server also sends `instructions` on initialize pointing at
the `trailstep://instructions` resource.

`@trailstep/sub-agents`: the delegate workflow descriptions (and the
`delegateParallel` description) now say what the workflow does, what `mode`
selects, that `maxTurns` bounds the number of turns, and that a delegate which
needs a decision returns a question answered with `trst_answer` and continued
with `trst_resume`. The generated per-workflow tool JSON takes its description
from the workflow description, so the live tools pick this up. The shipped
delegate skill files are built from `skillDescription` / `skillFocus` and are
unchanged.

`@trailstep/cli`: the pi MCP server description now points at the
`trailstep://instructions` resource that documents the run -> watch -> answer
-> resume loop.

Behavior is otherwise preserved.
