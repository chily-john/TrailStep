# @trailstep/cli

## 0.6.0

### Minor Changes

- d34b528: Split MCP server registration per scope: project/local registrations keep the `trailstep` server name with a pinned `mcp --project <absolute dir>` command, while global registrations now use the distinct `trailstep-global` server name and omit `--project` so the server follows the agent client's current project (layered project tools plus global `~/.trailstep` tools). Global manual and spawn argv now include `--global` and reflect the omitted `--project`, and the manual fallback command is rendered with the resolved scope's flags and server name when add-mcp cannot be resolved.
- a42b8b9: Lock `add-mcp` MCP registration to the resolved workflow scope and make the manual fallback robust. `trailstep init` and `trailstep add` now pass their resolved `--scope local|project|global` through to `offerMcpRegistration({ scope })`, so registration uses the same scope with no second WHERE prompt. Every manual fallback (`add-mcp` unresolvable, spawn failure, `ERR_TTY_INIT_FAILED`, or a declined local registration) now re-renders the printed `npx add-mcp` command with the resolved scope flags (`--gitignore` / `--global`) and the resolved server args. Headless `--yes` behavior is unchanged: no prompts, print the manual command, never spawn. `add-mcp` is promoted from a devDependency of `@trailstep/mcp` to a production dependency so published installs of `@trailstep/cli` can resolve the `add-mcp` bin entry (packaging trade-off: every `@trailstep/mcp` install now pulls in `add-mcp`; resolution walks cli -> `@trailstep/mcp` package root -> `add-mcp` and works even before `@trailstep/mcp`'s dist is built).

### Patch Changes

- Updated dependencies [a42b8b9]
  - @trailstep/mcp@0.2.1

## 0.5.0

### Minor Changes

- 30edf9e: Per-workflow MCP tools with automatic generation and registration. Adding a workflow now generates `.trailstep/mcp/trst_<id>.json` (description plus input params from `defineWorkflow` input shape), refreshed on `trailstep update --workflows`; the MCP server publishes each workflow as its own tool by default, with `mcp.perWorkflowTools: false` falling back to a `trst_list` catalog alongside the generic `trst_run_workflow` / `trst_watch` / `trst_answer` / `trst_resume` toolkit. `trailstep init` and `trailstep add` auto-offer `add-mcp` registration of the `trailstep mcp` server (absolute `--project`, headless-safe manual fallback). The legacy `skill` field in `defineWorkflow` remains accepted for backwards compatibility.
- eaa12bf: Added registration scope selection (project/local/global) to the MCP add-mcp offer. Interactive registration now asks where the MCP server entry should live after the register confirm: project (committed, default), local (project file appended to .gitignore with a preview before confirming), or global (user-level config, with a note that the entry still serves only the pinned project). Headless runs default to project scope and print the manual fallback without prompting. Scope flags are included in the rendered manual `npx add-mcp` command.
- 4dba420: Robust MCP server as thin adapters over existing run/watch/answer/continue seams. The MCP package now runs a real Model Context Protocol server (low-level Server plus StdioServerTransport): `trst_run_workflow` returns real run ids immediately while the run continues detached in the background, `trst_watch` streams `events.jsonl` offsets with long-poll, `trst_answer` writes real wait files with branch disambiguation, and `trst_resume` continues runs; `trailstep://project` and `trailstep://instructions` resources included. `trailstep mcp --project <dir>` is the foreground server (no detached spawn, no stubs). Core `load-order` uses `os.homedir` with explicit project dir and local-over-project-over-global precedence, and the manifest working-provider timeout guard no longer throws when no timeout is set.

### Patch Changes

- Updated dependencies [30edf9e]
- Updated dependencies [4dba420]
  - @trailstep/mcp@0.2.0
  - @trailstep/core@0.4.0

## 0.4.2

### Patch Changes

- f385f00: Add `--version` flag to the `trailstep` CLI. Prints the CLI package version and exits 0.
- cfc9af6: Fix silent exit when CLI binary is invoked through symlinks or hard links (e.g., workspace-linked global install). The `import.meta.url` vs `process.argv[1]` path comparison failed for linked paths, so `main()` was never called. Compare filenames (`index.js`) instead of full paths.

## 0.4.1

### Patch Changes

- 40871ed: Branch-scoped parallel wait-continue (Gaps 3+4) with branch-keyed parallel waits (Gaps 1+2).
  
  Gaps 1+2 (c0d78f5): decorateBranchEvent decorates wait.started/satisfied/failed with branchId+stepIndex on split tracks; waitEventKey/findPendingWaitsById/waitEventBranchId branch-aware with root fallback; trailstep answer accepts --branch and errors on ambiguous bare answers.
  
  Gaps 3+4 (594ac0b): replayToWaitingStep extended with optional branch scope {branchId, stepIndex} and readBranchRunState hydration; run-workflow.ts isWaitContinue replaces blanket guard with routing — resumes every waiting branch having recorded answer.json through root-continuation-array-scheduler restore (mirror retry path ~L971, never rebuild); unanswered branches stay waiting; done/failed/cancelled siblings never re-execute; CLI command.types.ts usageText documents --branch.
  
  Verification: core 389 tests pass; new co-located tests added; full E2E verified (delegate v4); regression verified clean (non-parallel paths unchanged); build green.
- 8e8bbe8: Fix Windows npm-shim spawning and bare `trailstep add` specs: working/custom/interactive provider commands and Pi model discovery now resolve `.cmd` shims to their Node entrypoint under `shell: false` (no-op on other platforms); bare npm specs like `@trailstep/create-flows` default to `@latest`, reusing the installed bundle when already present.
- Updated dependencies [40871ed]
- Updated dependencies [40871ed]
- Updated dependencies [8e8bbe8]
  - @trailstep/core@0.3.0

## 0.4.0

### Minor Changes

- 4465267: Add callback/check `.wait(...)` phases with `wait.done(...)` and `wait.pending(...)` helpers, durable pending metadata, and continue-time polling.
- aecaf30: Add durable workflow cancellation with `trailstep cancel <runNameOrRunDir>` and cancelled runtime results/events.
- 432547d: Add ambient immutable workflow input helpers, CLI input flags/setters, input templates, and final output printing.
- f6013f5: Add ordered durable `.wait(...)` phases for manual input pauses, including wait artifacts, wait events, waiting workflow results, and CLI answer guidance.
- 796d814: Add the imperative `notify` authoring API with durable progress, warning, and artifact events rendered by the CLI.
- 763827d: Add ordered `.display(...)` runtime phases that emit durable `step.display` events and render in the CLI terminal logger.
- 71f0ffe: Add the parallel-track runtime: track-scoped `globalState` with atomic branch storage, branch lifecycle and cleanup, track retry filters, and post continuations backing parallel delegate fan-out.
- 05fcb88: Publish provider-agnostic runtime support, provider package registration flows, and official provider packages.
- db93d74: Align the shared agent pool across packages (`planner`, `explorer`, `quick-implementor`, `smart-implementor`, `debugger`, `reviewer`, `expert`, `formatter`, plus `generalist` with demanding-model fallback), extend `trailstep agents explain` to workflow routing (`namespace/name`), re-apply missing package `recommendedConfig` additively on `trailstep update` (never overwriting user values), surface `trailstep doctor` drift warnings, and emit a compact agent routing progress note for working-agent steps.
- 9c9e7e0: Split recommended-config consent out of the blanket `trailstep update` confirmation: when recommended config additions ride along with package/skill changes, a second prompt asks whether to apply them, and declining skips only the recommended config writes while the rest of the update proceeds.
- 5f40583: `trailstep update` now picks up skills for new workflow exports of already-installed workflow packages: workflow exports without registry entries ("untracked workflows") get generated skills written to `.trailstep/skills/`, run via their package bundle ref, and distributed after workflow package installs. Untracked workflow skills are distributed only to the skill target(s) the user chose at `trailstep add` time (persisted per registration in workflow metadata). For legacy registrations without a recorded choice, update infers the targets from where that package's skills already exist (project vs. user skill directory) and otherwise defaults to project-only, reporting what was chosen.

### Patch Changes

- 71f0ffe: Fix `trailstep add` silently skipping `trailstep.recommendedConfig` for local directory package sources (such as `./packages/sub-agents`); agent pools and workflow role mappings are now applied additively, matching npm-backed adds.
- Updated dependencies [4465267]
- Updated dependencies [7c4875c]
- Updated dependencies [aecaf30]
- Updated dependencies [432547d]
- Updated dependencies [f6013f5]
- Updated dependencies [796d814]
- Updated dependencies [763827d]
- Updated dependencies [71f0ffe]
- Updated dependencies [05fcb88]
- Updated dependencies [db93d74]
- Updated dependencies [64ba8ae]
  - @trailstep/core@0.2.0

## 0.3.2

### Patch Changes

- f11b394: Improve README guidance for interactive setup and clearer workflow authoring examples.

## 0.3.1

### Patch Changes

- ba31526: Improve public README documentation, getting-started guidance, and npm package positioning.
- Updated dependencies [ba31526]
  - @trailstep/core@0.1.1

## 0.3.0

### Minor Changes

- 8b8bef8: Fix `trailstep update` so it updates the globally installed CLI by default and refreshes the bundled TrailStep skill.

## 0.2.0

### Minor Changes

- f8527c7: Update both the init, agents and add flows to be way easier to use.
