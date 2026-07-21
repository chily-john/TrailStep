# Agent Skills — Handoff

Status: design complete for two of three sub-features; one sub-feature is blocked on an open
product decision (see "Open questions" at the end). No implementation has started. This document
is the full context a fresh agent needs to pick this up with no prior conversation history.

## Why this exists

StepKit workflows currently have no way to be invoked as a "skill" from a coding agent (Claude
Code, Codex, Gemini CLI, etc.) other than by hand-writing a `SKILL.md`. Separately, StepKit's
interactive agent steps currently bake their entire hand-off protocol as inline prompt text on
every single step invocation, which is duplicated, verbose, and brittle. Both problems have the
same shape of solution — the [Agent Skills spec](https://agentskills.io) (`SKILL.md` with YAML
frontmatter) — and both can lean on the `skills` npm CLI (`vercel-labs/skills`,
https://github.com/vercel-labs/skills) for the parts of that spec's ecosystem that are genuinely
hard to reinvent (a ~75-agent directory registry, symlink/copy install fan-out, project-vs-user
scoping).

This work is split into three independent sub-features:

1. **One-off continue-skill** — replace the inline preamble in interactive agent steps with a
   proper `SKILL.md`-shaped prompt, generated in-process (no runtime dependency on the `skills`
   CLI).
2. **Per-workflow skill generation + distribution** — when a workflow is registered via
   `stepkit add`, optionally generate a `SKILL.md` for it and distribute it to project- and/or
   user-scoped agent skill directories via the real `skills` npm package.
3. **Drop `name` from workflow definitions** — a small, independent cleanup that both of the above
   depend on for correct skill-name derivation.

Do them in the order listed. (3) is a prerequisite/cheap win that should land first since (2)'s
skill-name derivation depends on it.

---

## Background research already done (don't redo this)

### `vercel-labs/skills` (the `skills` npm package)

- MIT licensed, ~26.8k GitHub stars, actively maintained by Vercel, requires Node >=22.20.
- It is a **CLI-only** package — its `package.json` declares `bin` but no `main`/`exports`. There
  is no importable JS API. Any integration must spawn its `bin/cli.mjs`, not `import` it.
- `skills add <source> [--agent <agent...>] [--skill <name...>] [-g|--global] [--copy] [-y]`
  installs skill(s) from a source (local path, GitHub repo, git URL, well-known URL) into every
  detected/specified agent's skill directory, either as a symlink to a canonical copy (default) or
  a real copy (`--copy`).
- **Scope defaults to project, not user.** Per its README's scope table:

  | Scope | Flag | Location | Use case |
  |---|---|---|---|
  | Project | *(default)* | `./<agent>/skills/` | Committed with the project, shared with the team |
  | Global | `-g`/`--global` | `~/<agent>/skills/` | Available across all projects for this user |

  So `skills add <dir> --agent '*' -y` (no `-g`) writes into e.g. `<repo>/.claude/skills/`,
  `<repo>/.codex/skills/`, etc. — exactly what's needed for "share this workflow's skill with the
  whole project team," not just the person who ran the command.
- `--agent '*'` forces install into **every** known agent's directory regardless of what's detected
  as locally installed. Without it, the CLI only writes to agents it auto-detects on the current
  machine — wrong for a team-shared project skill, since teammates may use a different agent than
  whoever ran `stepkit add`. Always use `--agent '*'` for the workflow-skill distribution feature.
- `agents.ts` in that package is a data table mapping ~75 agent names to their project/global skill
  directory paths and a `detectInstalled` check. This table is the actual reusable value of taking
  the dependency — don't hand-roll or vendor it; it changes as new agents ship upstream, and a
  hand-copied version will rot.
- `skills use <source> [--skill <name>] [--agent <agent>]` is a **separate, one-off** flow (no
  install, nothing written to any agent directory): it resolves a skill, wraps its raw `SKILL.md`
  content in a fixed prompt template (`buildUsePrompt` in `src/use.ts`), and either prints the
  wrapped prompt to stdout (for piping into any agent CLI: `skills use <src> | claude`) or, only
  for `claude-code`/`codex` (the only two entries in its `USE_AGENT_CONFIGS` map), spawns that agent
  interactively with the prompt as the initial argument.
- The exact wrap shape (`buildUsePrompt`, `src/use.ts`), reproduced here because sub-feature 1
  reimplements it:

  ```
  You are being given a Skill to execute for the user's next request.
  Use the following SKILL.md as your instructions:
  <SKILL.md>
  ...raw SKILL.md file contents, frontmatter included...
  </SKILL.md>
  ```

  (Plus an optional trailing note about a supporting-files directory, not needed for our case —
  the continue-skill has no supporting files.)
- Confirmed: even Vercel's own tool has no native "load this skill for one turn" flag on any
  wrapped agent CLI — for its `--agent` direct-launch path it does the exact same thing (spawns the
  agent binary with the wrapped prompt as a plain positional argument). Prompt-injection via the
  `<SKILL.md>` tag is the actual current state of the art here, not a workaround.

### SKILL.md spec basics

Required frontmatter: `name` (lowercase, hyphens), `description` (what it does and when to use
it). Optional `metadata.internal: true` hides it from the `skills` CLI's normal discovery (not
relevant to sub-feature 1, since that path never goes through the `skills` CLI's discovery at all).

---

## Sub-feature 3: Drop `name` from workflow definitions (do this first)

**What**: Remove the `name?: string` field from `WorkflowBuilderOptions` and `DefinedWorkflow` in
`packages/sdk/src/workflow-builder/workflow-builder.types.ts` (lines 7-8 and 15 as of this
writing). Workflows are identified by `id` only going forward.

**Why**: Confirmed via repo-wide grep that `name` is a pure type-level field — `workflow-builder.ts`
itself never reads it, and no runtime code in `packages/core/src` touches `workflow.name` (the
`.name` hits that do exist are unrelated — `Error.name`, `StepKitFailureError.name`, etc.). This is
a clean, isolated deletion with zero runtime ripple. Sub-feature 2's skill generator needs to derive
a skill's `name:` frontmatter from `workflow.id` (sanitized to kebab-case) rather than a separate
`name` field, so this should land before that generator is written.

**Work**:
- Delete the `name` field from both interfaces in `workflow-builder.types.ts`.
- Check `packages/sdk/src/builders.test.ts` and any other test fixtures for `name:` passed into
  workflow definitions and remove it.
- Run `pnpm typecheck` to catch any consumer that was reading `.name` off a `DefinedWorkflow`.

**LOE**: ~15-30 minutes.

---

## Sub-feature 1: One-off continue-skill for interactive agent steps

### Current state (as of this writing)

Interactive agent steps already run on a fully file/env-var-driven protocol, decoupled from prompt
text — this is what makes the skill-wrap change possible without touching the protocol itself:

- `packages/core/src/agent-execution/interactive-agent/run-interactive-agent-command/run-interactive-agent-command.ts:79`
  sets `STEPKIT_INTERACTIVE_FILE` in the spawned agent process's env, for every provider.
- `prepareInteractiveArtifacts` (same file, lines 237-272) writes `interactive.json` **before** the
  agent process is spawned. It contains `status`, `outputMode` (`"session-file"` or `"json"`),
  `outputSchema`, `stepDir`, `outputFile`, `promptFile`, `interactiveFile`, and (for session-file
  mode) `sessionDescriptionFile` — everything an agent needs to complete the hand-off, all
  discoverable via the env var alone.
- `stepkit continue` (`packages/cli/src/internals/commands/continue/continue-command.ts`) reads
  that env var, loads `interactive.json`, validates submitted output against `outputSchema`, writes
  the result, and flips `status` to `completed`. It has **zero coupling to prompt text** — this
  command does not need to change for sub-feature 1.
- `outputMode` is decided dynamically, per step, in
  `packages/core/src/runtime/continuation/run-continuation/run-continuation.ts:101-104`:

  ```ts
  interactiveOutputMode:
    config.agentMode === "interactive" && config.outputShape !== undefined
      ? "json"
      : "session-file",
  ```

  No step-level `outputShape` declared → `session-file` mode (free-form summary, agent runs
  `stepkit continue --session-file <path>`). `outputShape` declared → `json` mode (schema-validated
  object, agent runs `stepkit continue --json-file <path>` or `--json '<json>'`). This is already
  correct and dynamic — nothing to build here, sub-feature 1 only needs to relocate the two
  branches of *text* that currently describe this, not change the decision logic.
- The problem: `buildInteractivePrompt`
  (`run-interactive-agent-command.ts:274-305`) hardcodes the entire protocol as inline bullet-list
  text, branching on `outputMode`, and this text becomes the literal opening prompt passed to the
  agent CLI (e.g. `claude-provider.ts:94`: `args.push(request.prompt)` — the whole thing is a
  single positional CLI argument). This is duplicated on every single interactive step open and is
  disconnected from the `SKILL.md` ecosystem.

### What to build

**Do not** take a runtime dependency on the `skills` CLI for this. Considered and rejected —
reasoning below — in favor of vendoring the ~15-line wrap logic directly.

Why reject shelling out to `skills use` here specifically:
- For a local path source, `skills use`'s only real work is: check the path exists, read the
  `SKILL.md` file, wrap it in the fixed template shown above. That's the entire value for our case.
- Shelling out costs: one extra process spawn per interactive-step open, cross-platform binary
  resolution risk (Windows `.cmd` shims — real, non-trivial), a runtime dependency whose *internal*
  behavior could shift across its own version bumps (only its CLI surface is a stable contract),
  and a new failure mode (spawn error / missing binary) unrelated to StepKit's own logic.
- Vendoring the ~15-line wrap function has none of that: pure sync file read + string template,
  identical on every OS, no extra dependency, no process-spawn latency, no version-drift risk —
  while still using the exact same technique (confirmed above to be what Vercel's own tool does
  internally, not a shortcut).
- Keep the `skills` package as a real dependency for sub-feature 2 only, where its actual value
  (the 75-agent registry + install/symlink machinery) is genuinely used.

**Concrete tasks**:

1. Author a static `SKILL.md` at
   `packages/core/src/agent-execution/interactive-agent/one-off-continue-skill/SKILL.md`. The
   directory name is deliberate — it must read as "the one-off skill," not "a skill living in
   here among others." Content: valid YAML frontmatter (`name`, `description`) plus body
   instructions covering **both** `outputMode` branches (read `$STEPKIT_INTERACTIVE_FILE`, branch
   on its `outputMode` field, write `session-description.md` per the dense-context guidance
   currently in `buildInteractivePrompt`'s session-file branch, or build/validate a JSON object per
   `outputSchema` per the json branch, then run the correct `stepkit continue` invocation). Mention
   watching for the user typing something like `/continue` (or otherwise indicating they're done)
   as the trigger to start this hand-off — this works without any actual slash-command
   registration anywhere, because the whole skill's text is injected into the agent's context at
   session start, so the agent just needs to be told what phrase to watch for.
2. Vendor the wrap function (mirroring `buildUsePrompt`'s exact `<SKILL.md>` shape from above) as
   a small new module, e.g.
   `packages/core/src/agent-execution/interactive-agent/one-off-continue-skill/resolve-one-off-continue-skill-prompt.ts`
   — reads the SKILL.md file above, returns the wrapped string. Async (file read), matches codebase
   convention of injectable functions for testability where useful.
3. In `run-interactive-agent-command.ts`, replace (or gut) `buildInteractivePrompt` (lines
   274-305) so the returned prompt is: `[wrappedSkillPrompt, "", "## Original prompt",
   options.renderedPrompt].join("\n")`. The `## Original prompt` section is unchanged — it's the
   step's actual work instructions and stays separate from the protocol skill. This makes the
   caller of `buildInteractivePrompt` async now (it currently isn't) — thread that through
   `runInteractiveAgentTarget` (same file, around line 73) with an `await`.
4. Packaging: the SKILL.md file must ship inside the published `@stepkit/core` npm package.
   Currently `packages/core/package.json`'s `files` field is `["dist", "README.md", "LICENSE"]` and
   the build script is `tsup src/index.ts --format esm --dts --sourcemap --clean` — `--clean` wipes
   `dist/` on every build, and tsup does not copy non-JS assets by default. Add a copy step (e.g. a
   small `postbuild` script or an addition to the `build` script) that copies the
   `one-off-continue-skill/` directory into `dist/` after the tsup build, and add that path to
   `files`. This is easy to silently break on a future `--clean` if the copy step is forgotten —
   worth a comment or a test that asserts the file exists post-build.
5. Update tests. `run-interactive-agent-command.test.ts` currently asserts on the literal old
   preamble text at lines 374, 403, and 593 (e.g. `expect(prompt).toContain("## Original
   prompt\nDiscuss dense context.")`, `.toContain("stepkit continue --session-file
   session-description.md")`). These need rewriting: either update them to assert against the new
   `<SKILL.md>` wrapper shape plus a stubbed/mocked skill file, or move the protocol-text assertions
   into a new dedicated test for the wrap-function module, and leave the command test asserting
   only on structural things (that the skill prompt precedes `## Original prompt`, etc.).

**Decisions made, stated explicitly so the next agent doesn't relitigate them**:
- Vendored wrap, not a `skills` CLI spawn, for this feature specifically (see reasoning above).
- No fallback path to the old inline preamble was decided on — recommend failing the step outright
  (clear `StepKitFailureError`) if the bundled SKILL.md file is somehow missing/unreadable at
  runtime, rather than silently falling back to different behavior. This was flagged to the user as
  a call to confirm, not yet explicitly confirmed — **flag it again to the user before or during
  implementation** if it hasn't been settled by the time this is picked up.

**LOE**: ~3-4 hours (skill authoring ~1-2h, wrap function + packaging fix ~1h, wiring +
async-threading ~1h, test rewrite ~1h).

---

## Sub-feature 2: Per-workflow skill generation + distribution via `stepkit add`

### Current state

- `stepkit skill-check` (`packages/cli/src/internals/commands/skill-check/skill-check-command.ts`
  + `skill-detection.ts`) is a **checker only** — it groups discovered workflows by package
  (`groupWorkflowsByPackage`, `skill-detection.ts:29-50`) and reports (always exit 0) any package
  missing a root `SKILL.md` (`hasSkillFile`, `skill-detection.ts:52-59`, a plain `access()` check).
  Nothing anywhere writes a `SKILL.md`. This command's tests and rule doc
  (`.pi/rules/packages/cli/src/internals/commands/skill-check/skill-check.md`) confirm its scope is
  explicitly report-only.
- `Workflow` (`packages/core/src/authoring/workflow/workflow.types.ts:5-16`) has `id`, optional
  `input`/`output` `Schema`, `inputShape`/`outputShape`, `agents`, `start`. No `description` field
  at the core level. `DefinedWorkflow` (sdk, post sub-feature-3 cleanup) adds `description?: string`
  only (no `name` anymore). `discoverWorkflows()`
  (`packages/cli/src/internals/discovery/discovery.ts`) returns `DiscoveredWorkflow { id,
  packageName, packageDir, exportName, workflow: Workflow }` — check whether the `Workflow` cast
  at the discovery boundary preserves `description` (it comes from the sdk-level `DefinedWorkflow`,
  which is a superset of core `Workflow`) or erases it; this needs verifying/fixing so the generator
  can actually read `description`.
- `stepkit add` (`packages/cli/src/internals/commands/add/add-command.ts`) registers a workflow
  *reference* into `.stepkit/config.json` (project- or user-scoped, `configPathForScope`, lines
  246-249). It does **not** currently do anything with `SKILL.md`. Important: for the **direct
  file** source path, it already loads the workflow module into memory via `loadDirectWorkflowFile`
  (line 189) as part of validation — this can be reused directly to get `id`/`description` for
  skill generation, no extra discovery pass needed. For the **bundle** source path (lines 193-232,
  `isBundleSource`/`readBundleWorkflowNames`), it currently only reads workflow *names* out of the
  bundle's `package.json` `stepkit.workflows` manifest — it never imports the actual workflow
  module. Skill generation for a bundle-sourced workflow needs an added import step to get
  `description`.
- `context.prompts` (`packages/cli/src/internals/command.types.ts:33-36`, `StepkitCliPrompts`) only
  exposes `text(prompt)` and `select(prompt, choices)` — **no multi-select primitive**. `add-command.ts`
  already uses both for scope/namespace/name prompts (`resolveInteractiveArgs`,
  `promptSelect`, lines 113-155), including the pattern for what happens when `context.prompts` is
  undefined (throws `CliUsageError` demanding an explicit flag) — that pattern is for *required*
  inputs and should **not** be copied as-is for this feature, since skill creation is optional (see
  below).

### What to build

**Trigger point**: hook into `stepkit add`, after the workflow reference is successfully written to
`.stepkit/config.json` (`add-command.ts`, after line 74). Do **not** generate/write the `SKILL.md`
into the workflow's source package directory — for a bundle/third-party-package source that could
mean writing into `node_modules`, which is wrong. Instead, generate into the *consumer's own
project*, e.g. `.stepkit/skills/<namespace>-<name>/SKILL.md`, then use the `skills` CLI purely for
its distribution/install-fan-out step against that generated directory.

1. **Generator module** — new file (e.g.
   `packages/cli/src/internals/commands/add/generate-workflow-skill.ts` or alongside
   `skill-check`): given a `DiscoveredWorkflow`/loaded workflow object, produce `SKILL.md` content —
   YAML frontmatter with `name:` derived from `workflow.id` (sanitized: lowercase, hyphens — see
   sub-feature 3, and see `sanitizeName` in `vercel-labs/skills`' `installer.ts` for the exact
   sanitization convention to mirror if useful) and `description:` from `workflow.description`
   (falling back to something sensible if undefined — decide/confirm with the user whether an
   undefined description should block skill creation or use a generic fallback). Body: how to
   invoke the workflow (`stepkit run <id>` or whatever the actual run invocation looks like — check
   `run-command.ts`/`usageText` in `command.types.ts` for the exact current syntax), plus an input
   schema summary if `workflow.input`/`inputShape` is set.
2. **Prompt for skill creation** — after successful registration, ask (via two sequential `select`
   yes/no prompts — chosen over adding a new `multiSelect` primitive to keep the `StepkitCliPrompts`
   interface unchanged, per the repo's stated preference for not adding abstraction beyond what's
   needed): "Add to project skills?" and "Add to user skills?" — both can be answered yes,
   independently, since a user may want it in both places. Add corresponding non-interactive flags
   (e.g. `--project-skill` / `--user-skill`, matching the existing boolean-flag convention like
   `--force`) for scripted use. When `context.prompts` is undefined **and** neither flag is passed,
   default to skipping skill creation entirely rather than throwing — this is an optional
   enhancement, not a required input, and must not block scripted/CI `stepkit add` invocations.
3. **Bundle-source metadata gap** — when skill creation is requested for a bundle-sourced workflow,
   add the missing import step (mirroring how `discoverWorkflows`/`loadDirectWorkflowFile` import a
   workflow module) so `description` is available. Direct-file sources already have this for free
   via the existing `loadDirectWorkflowFile` call.
4. **Distribution** — new module, spawn the real `skills` CLI:
   `skills add <generatedSkillDir> --agent '*' -y` for the project-scope answer, and/or
   `skills add <generatedSkillDir> --agent '*' -y -g` for the user-scope answer. Mirror the
   spawn/injectable-runner/error-wrapping style already used for provider CLIs (see
   `claude-provider.ts:107-123`'s `spawnClaudeCapturingStdout` for the shape to match). This *is*
   where the real `skills` npm dependency is added — to `@stepkit/cli`'s `package.json` — and where
   the earlier-flagged cross-platform binary-resolution work belongs: don't rely on `skills` being
   on `PATH`; resolve it via `createRequire(...).resolve("skills/package.json")` → join `dirname` +
   `bin/cli.mjs` → spawn as `node <path> add ...` (avoids Windows `.cmd` shim inconsistencies).
5. **Failure containment** — if skill generation or distribution fails (e.g. the `skills` CLI spawn
   errors), this must be **best-effort**: log/warn, do not throw in a way that makes `stepkit add`
   report failure, since the actual config registration (the command's primary job) already
   succeeded and was persisted before this step runs.

**Decisions made, stated explicitly**:
- Skill files are generated into the consumer's own project (`.stepkit/skills/...`), never into a
  third-party package's directory, specifically to sidestep writing into `node_modules`.
- `--agent '*'` is used unconditionally for distribution (not relying on local agent
  auto-detection), since a project-scoped skill should reach every teammate regardless of which
  agent CLI happens to be installed on the machine that ran `stepkit add`.
- Two sequential `select` prompts over adding a `multiSelect` primitive — revisit this only if the
  UX friction turns out to matter in practice; it was a deliberate scope-minimization call, not an
  oversight.

**LOE**: ~1.5-2 days total — generator (~2-3h), type/description-preservation fix at the discovery
boundary (~1h), prompts + non-interactive flags + default-skip behavior (~2h), bundle-source
metadata load (~1-2h), distribution spawn module + Windows binary resolution (~2-3h), failure
containment (~1h), tests across all of the above (~4-6h).

---

## Open questions (unresolved — do not guess on these)

1. **Context export on workflow resume, gated on workflow-level `input`/`inputShape`.** The user
   raised this but the conversation ended before it was clarified — do not implement anything for
   it without re-confirming the intent. As best understood so far: the question is whether, when a
   workflow declares a top-level `input`/`inputShape` (`Workflow.input?`/`inputShape?`, **not** the
   per-step `outputShape` that already drives `session-file`-vs-`json` mode at
   `run-continuation.ts:101-104` — these are two different, unrelated fields), an interactive
   step's captured context (`session-description.md` or the json output) should be exported/threaded
   forward as input to a subsequent `start` call on resume. This needs a concrete worked example
   from the user (what resume flow, what code path) before scoping — get that before starting any
   work here. This is **not** a blocker for sub-features 1-3 above, which are independently scoped
   and do not depend on this answer.
2. **Undefined `workflow.description` at skill-generation time** (sub-feature 2, task 1): block
   skill creation with an error, or synthesize a generic fallback description? Not yet decided.
3. **Fallback behavior if the bundled one-off-continue-skill file is missing/unreadable at runtime**
   (sub-feature 1): recommended hard-fail, not yet explicitly confirmed by the user.

## Explicitly out of scope / unchanged

- `stepkit continue` / `continue-command.ts` — protocol is already file/env-driven, no changes
  needed for sub-feature 1.
- Provider adapters (`claude-provider.ts`, `codex-provider.ts`, `gemini-provider.ts`,
  `pi-provider.ts`) — unchanged; they already just receive a single prompt string and spawn.
- `skill-check` command's existence/behavior as a checker — sub-feature 2 adds a *writer* alongside
  it (or a flag on it); it does not need to remove or replace the existing checker.
