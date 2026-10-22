# @trailstep/sub-agents

## 0.3.2

### Patch Changes

- 9fc5734: HARD-REMOVE the deprecated per-workflow generated-skills feature from the TrailStep CLI.
  
  Breaking changes:
  
  - `trailstep add` no longer accepts `--project-skill` or `--user-skill`; both flags are now rejected as unknown options.
  - Generated per-workflow skill files are no longer written during `trailstep add`.
  
  Migration:
  
  - Agents that should discover registered workflows use the TrailStep MCP server (`trst_*` tools) or the packaged TrailStep skills installed via `trailstep init --install-skill`.
  
  No changes for `trailstep init --install-skill`, `trailstep skill-check`, the packaged `trailstep-skill` / authoring-skill installs, or provider execution-time skill handling.
- Updated dependencies [9fc5734]
  - @trailstep/authoring@0.4.1

## 0.3.1

### Patch Changes

- 28e6560: Agents now load the project's context files by default, and the user can
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
- 337eab6: Coerce stringified workflow input scalars and enrich the MCP tool descriptions.
  
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
- 51d35f5: Share the remaining duplicated helpers.
  
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
- Updated dependencies [51d35f5]
  - @trailstep/authoring@0.4.0

## 0.3.0

### Minor Changes

- 805dbe9: Add opt-in lean `execution` context (`AgentExecutionConfig`, `resolveAgentExecutionConfig`, `DEFAULT_AGENT_EXECUTION`) on agent steps and workflow roles, rendered through provider `hygiene` capability mappings into `{{tools}}`, `{{skills}}`, `{{mcpArgs}}`, `{{extensionsArgs}}`, and `{{contextFilesArgs}}` argv templates. Wire hygiene placeholders into all four provider manifests (pi, claude, codex, gemini), default every delegate workflow to the lean context, and document flag splitting plus the `project-only` collapse on CLIs without a dedicated project-only flag.

### Patch Changes

- 69db9a9: Retry transient working-agent spawn failures with exponential backoff instead of burning the agent target chain. Windows process-level deaths (e.g. `0xC0000142` `STATUS_DLL_INIT_FAILED`) and resource-exhausted spawn errors are now classified as transient: the format phase is retried in the same session (never re-running Phase 1 work) and failing targets are retried before falling back, with growing jittered delays (default 4 attempts, 2s base, x3, 60s cap) configurable via `settings.spawnRetry`. Failures are now visible the moment they happen: new `agent.attemptFailed` events, an incremental `attempts.json` audit trail per step, and captured spawn `stderr.txt` artifacts. Track state records `ownerPid` so runs left `running` by a dead runner are reported as orphaned instead of silently active.
- Updated dependencies [805dbe9]
- Updated dependencies [69db9a9]
  - @trailstep/authoring@0.3.0

## 0.2.2

### Patch Changes

- @trailstep/authoring@0.2.2

## 0.2.1

### Patch Changes

- 40871ed: Delegate skill descriptions updated to more direct/aggressive language; core working-agent prompts switched to two-phase architecture (work without output shape, then same-session format/reformat with output schema).
  
  Sub-agents (`packages/sub-agents/src/delegate/workflow.ts` + `delegate-parallel/workflow.ts`): all delegate skill descriptions (`delegate`, `delegateExplore`, `delegateSimpleExplore`, `delegateArchitectPlanner`, `delegateReview`, `delegateImplement`, `delegateQuickImplementor`, `delegateSmartImplementor`, `delegateRelentlessDebugger`, `delegateSchemaFormatter`, `delegateParallel`) rewritten from passive "Use as a sub-agent for..." to directive/conditional "Use when you need..." / "Read-only exploration that summarizes findings without editing files." / "When instructions are already concrete..." etc. Skill descriptions and skill focus fields now include explicit parallel recommendations ("If you have 2+ independent tasks, use trst-delegate-parallel instead of calling this sequentially.").
  
  Core (`packages/core/src/agent-execution/working-agent/prompts/build-two-phase-prompts.ts` + artifacts + tests): new two-phase working-agent prompt architecture. Phase 1 (`buildWorkPrompt`) embeds the original prompt with zero mention of output files, JSON, or schemas — avoiding the long-turn domain-JSON problem. Phase 2 (`buildFormatPrompt`) is a pinned same-session follow-up that asks the agent to reformat its last answer to exactly one JSON object matching the strict output schema; includes validation error feedback when needed. New artifact paths: `workFile` (`work.txt`) and `repairPromptFile` (`repair-prompt.md`). Tests verify that work prompts contain the original prompt but no JSON/schema references, and format prompts include the stringified schema, require a single JSON object, and omit validation sections when no errors exist.
- @trailstep/authoring@0.2.1

## 0.2.0

### Minor Changes

- 0390822: Introduce the public sub-agents package with delegate workflows, including the parallel delegate workflow export.
- db93d74: Align the shared agent pool across packages (`planner`, `explorer`, `quick-implementor`, `smart-implementor`, `debugger`, `reviewer`, `expert`, `formatter`, plus `generalist` with demanding-model fallback), extend `trailstep agents explain` to workflow routing (`namespace/name`), re-apply missing package `recommendedConfig` additively on `trailstep update` (never overwriting user values), surface `trailstep doctor` drift warnings, and emit a compact agent routing progress note for working-agent steps.

### Patch Changes

- Updated dependencies [4465267]
- Updated dependencies [432547d]
- Updated dependencies [f6013f5]
- Updated dependencies [796d814]
- Updated dependencies [763827d]
- Updated dependencies [71f0ffe]
- Updated dependencies [64ba8ae]
  - @trailstep/authoring@0.2.0
