# @trailstep/create-flows

## 0.3.9

### Patch Changes

- Updated dependencies [cf75cb1]
- Updated dependencies [6ba4d32]
  - @trailstep/authoring@0.4.2

## 0.3.8

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

## 0.3.7

### Patch Changes

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
- 3d3dc86: Verticalize the CLI internals and the create-flows shared directory.
  
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
- Updated dependencies [51d35f5]
  - @trailstep/authoring@0.4.0

## 0.3.6

### Patch Changes

- daa90b9: Fix `take-it-away` workflow tests that omitted `cwd` on retry `runWorkflow` calls, which made the story auto-commit step run `git add -A` and commit against the ambient repository instead of the test's temporary repo. The retry tests are now scoped to their temp working directory.
- Updated dependencies [805dbe9]
- Updated dependencies [69db9a9]
  - @trailstep/authoring@0.3.0

## 0.3.5

### Patch Changes

- 2dd0469: Remove the graphify availability hint from deterministic context preflight. Structural search hints now use focused `rg` suggestions only.
- @trailstep/authoring@0.2.2

## 0.3.4

### Patch Changes

- @trailstep/authoring@0.2.1

## 0.3.3

### Patch Changes

- 402144e: Refine feature-doc distillation prompts to preserve requested scope, uncertainty, non-goals, conversation context, and optional future ideas separately.
- Updated dependencies [4465267]
- Updated dependencies [432547d]
- Updated dependencies [f6013f5]
- Updated dependencies [796d814]
- Updated dependencies [763827d]
- Updated dependencies [71f0ffe]
- Updated dependencies [64ba8ae]
  - @trailstep/authoring@0.2.0

## 0.3.2

### Patch Changes

- f11b394: Improve README guidance for interactive setup and clearer workflow authoring examples.
- Updated dependencies [f11b394]
  - @trailstep/authoring@0.1.2

## 0.3.1

### Patch Changes

- ba31526: Improve public README documentation, getting-started guidance, and npm package positioning.
- Updated dependencies [ba31526]
  - @trailstep/authoring@0.1.1

## 0.3.0

### Minor Changes

- f110478: Made a minor change to the new feature prompt so that it's project agnostic

## 0.2.0

### Minor Changes

- 208deed: Updated the packages to actually work properly

### Patch Changes

- 40fcc52: Inline markdown prompt fragments into the bundled workflow entrypoint so installed npm packages do not require copied shared assets at runtime.
