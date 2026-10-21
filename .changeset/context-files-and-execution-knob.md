---
"@trailstep/core": patch
"@trailstep/sub-agents": patch
---

Agents now load the project's context files by default, and the user can
control the whole execution (hygiene) block from the TrailStep config.

`@trailstep/core` changes the default execution block from
`contextFiles: "project-only"` to `contextFiles: true`. `"project-only"` was
misleading on every provider CLI that has no project-only flag: `pi
--no-context-files` disables AGENTS.md/CLAUDE.md discovery entirely, so the
value that claimed to restrict context to the project actually removed it. An
agent with an execution block now loads the project's context files unless it
opts out, and the value stays available for providers that do offer a
project-only flag.

`@trailstep/core` also adds `settings.execution` to the TrailStep config, both
globally (`settings.execution`) and per workflow
(`workflows.<id>.settings.execution`). The block has the same shape as
`AgentExecutionConfig` (`tools`, `skills`, `mcp`, `extensions`, `contextFiles`)
and is merged field by field with the agent role's own block: step execution >
per-workflow config > global config > role, per field. A config block that
names only `contextFiles` therefore changes only that field and leaves the
role's other fields alone; an explicit `false` or `[]` overrides a
lower-precedence value. An invalid config block fails fast with a
config-scoped diagnostic before any provider process is spawned, and no block
anywhere still means "render no hygiene args at all".

`@trailstep/sub-agents` no longer pins `contextFiles` in the delegate's lean
execution block, so a delegate turn inherits the framework default and reads
the repository's own `AGENTS.md` / `CLAUDE.md` instead of disabling context
discovery. The rest of the lean block is unchanged: `--no-skills`, `--no-mcp`
and `--no-extensions` are still rendered, and all tools stay available.

Behavior is otherwise preserved.
