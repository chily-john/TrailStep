# Agent Config Overhaul — Handoff

Status: design complete, no implementation started. This document assumes **zero prior context**
— you have not read the conversation that produced it, and you may be new to this codebase. Every
term, every current file, and every target shape is spelled out in full below. Read the Glossary
first if any term below is unfamiliar, then read "Why this exists," then work sub-feature by
sub-feature in the listed order.

## Glossary (read this first if any term below is unfamiliar)

- **Provider**: a coding-agent CLI StepKit knows how to drive — `claude`, `codex`, `pi`, `gemini`
  are the four built-in ones. A "custom provider" is any other CLI binary you wire up by hand.
- **Target**: one concrete instruction for "run this specific provider, with this model, with this
  thinking level." Shape: `{ provider, model?, thinking?, args? }`.
- **Fallback chain**: a list of targets tried in order — target 1 first, and only if it fails does
  StepKit try target 2, and so on. This already exists today and is not changing.
- **Role**: a named slot a workflow author declares it needs an agent for, e.g. `"reviewer"` or
  `"implementor"`. Declared on the workflow itself (`workflow.agents.reviewer = { size: "large",
  description: "..." }`), not in `.stepkit/config.json`.
- **Size**: one of six fixed tiers (`default`, `tiny`, `small`, `medium`, `large`, `xl`) a role can
  request instead of (or in addition to) a specific named agent. Acts as a shared fallback bucket —
  many roles across many workflows can all fall back to the same `"medium"` configuration instead
  of each workflow needing its own explicit mapping.
- **Thinking**: a reasoning-effort dial (`low`, `medium`, `high`, `xhigh`, `max`), independent of
  provider/model, threaded into providers that support it.
- **Scope**: which of three files a piece of config lives in — **project** (`.stepkit/config.json`,
  committed to git, shared with the team), **project-local** (`.stepkit/config-local.json`,
  gitignored, machine-specific overrides), or **user** (`~/.stepkit/config.json`, this person's
  home directory, applies across all their projects).
- **Named agent / entry**: a reusable, named target-or-fallback-chain living in the top-level
  `agents` map in config — e.g. `"workerA"` — that can be referenced from multiple places instead
  of being copy-pasted.
- **Ref**: a pointer, `{ "ref": "workerA" }`, used inside an entry's `items` list to mean "reuse
  whatever `workerA` resolves to here" instead of writing out a literal target again.
- **Item**: one element of an entry's `items` array — either a literal target object or a `{ref}`
  pointer. This is the *new* unified building block this whole feature introduces.
- **One-off**: a target configured for a single workflow role only, never saved to the reusable
  top-level `agents` map.

---

## Why this exists

Getting StepKit's agent-agnostic workflow system working today is clunky:

- There is no `stepkit init` or any scaffold command — a brand-new project starts from nothing.
- `.stepkit/config.json`'s agent-targeting section must be hand-authored from scratch, by reading
  internal rules docs, with zero CLI help picking providers or models.
- `stepkit add` (the command that registers a workflow so you can run it by a short name) only
  ever writes the `workflows` registry key. It never looks at a workflow's declared agent roles or
  helps you configure them, even though a workflow can fail at runtime with a cryptic error the
  first time it hits an unconfigured role.
- There is no way to reuse one agent configuration (provider + model + thinking) across multiple
  workflows or roles — today you'd copy-paste the same JSON block everywhere you want the same
  agent, and if you ever need to change it (e.g. bump a model version), you have to find and edit
  every copy by hand.
- `workingAgents` and `interactiveAgents` are two separate, parallel config maps, even though for
  all four built-in providers a single target already works fine in both modes — this doubles the
  config you have to write for no real benefit in the common case.

This work is split into sub-features. **Do them in this order** — later ones depend on earlier ones
existing and working:

1. `.gitignore` fix (5 minutes, no dependencies, do it immediately).
2. Core schema rewrite in `@stepkit/core` (the foundation — nothing else can be built correctly
   until this lands).
3. Shared CLI flow modules (reusable building blocks used by both commands below).
4. `stepkit init` (thin, built on #3).
5. `stepkit agents` (the largest piece, built on #3).
6. `stepkit add` role-prompting integration (wires into #3 as well).

---

## Full current-state reference (read carefully before touching anything)

### Current `StepKitConfig` type (as it exists today, before this feature)

File: `packages/core/src/agent-targeting/targeting.types.ts`

```ts
export type StepKitAgentMode = "working" | "interactive";

export interface StepKitCustomAgentConfig {
  readonly binary: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface StepKitAgentTarget {
  readonly provider: string; // built-in registry key, OR a customAgents key
  readonly model?: string;
  readonly thinking?: WorkflowAgentThinking;
  readonly args?: readonly string[];
}

export type StepKitSizeAgentMappings = Partial<
  Readonly<Record<WorkflowAgentSize, readonly StepKitAgentTarget[]>>
>;

export type StepKitRoleAgentMappings = Readonly<Record<string, readonly StepKitAgentTarget[]>>;

export interface StepKitWorkflowConfig {
  readonly workingAgents?: StepKitRoleAgentMappings;
  readonly interactiveAgents?: StepKitRoleAgentMappings;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface StepKitConfig {
  readonly version: 1;
  readonly customAgents: Readonly<Record<string, StepKitCustomAgentConfig>>;
  readonly workingAgents: StepKitSizeAgentMappings;
  readonly interactiveAgents: StepKitSizeAgentMappings;
  readonly workflows?: Readonly<Record<string, StepKitWorkflowConfig>>;
}
```

Related types, `packages/core/src/contracts/agents/agent-role.types.ts` (this file is **not**
changing in this feature — shown here only so you understand what a workflow author writes):

```ts
export type WorkflowAgentSize = "default" | "tiny" | "small" | "medium" | "large" | "xl";
export type WorkflowAgentThinking = "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkflowAgentRole {
  readonly description?: string;
  readonly size: WorkflowAgentSize;
  readonly thinking?: WorkflowAgentThinking;
  readonly name?: string;
}
```

A workflow author writes, e.g.:

```ts
defineWorkflow({
  id: "project/review",
  agents: {
    reviewer: { size: "large", description: "Reads a diff and flags correctness issues." },
    implementor: { size: "medium", description: "Applies the fix reviewer approved." },
  },
  start: (input) => { /* ... */ },
});
```

A step then does `.agent("reviewer")` to say "run this step using whatever the `reviewer` role
resolves to." If a step doesn't say `.agent(...)`, it falls back to a role literally named
`"default"` if the workflow declares one, else a builtin `{ size: "default" }`.

### Current example `.stepkit/config.json` (what a human has to hand-write today)

```json
{
  "version": 1,
  "customAgents": {
    "my-custom-cli": { "binary": "my-agent", "args": ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"] }
  },
  "workingAgents": {
    "default": [{ "provider": "claude", "model": "sonnet" }],
    "large": [{ "provider": "codex", "model": "gpt-5", "thinking": "high" }]
  },
  "interactiveAgents": {
    "default": [{ "provider": "claude", "model": "sonnet" }]
  },
  "workflows": {
    "project/review": {
      "workingAgents": {
        "reviewer": [{ "provider": "codex", "model": "gpt-5" }]
      }
    }
  }
}
```

Notice `workingAgents.default` and `interactiveAgents.default` are *identical* here — this
duplication is exactly the "needless split" this feature removes for the common case.

### Current resolution logic (how a role turns into a real provider invocation)

File: `packages/core/src/agent-targeting/resolve-agent-targets/resolve-agent-targets.ts`

```ts
export function resolveAgentTargets(options: ResolveAgentTargetsOptions): readonly StepKitAgentTarget[] {
  const modeMappings = options.mode === "working" ? options.config.workingAgents : options.config.interactiveAgents;
  const workflowMappings = options.config.workflows?.[options.workflowId]?.[`${options.mode}Agents`];

  const targetLists = [
    workflowMappings?.[options.roleName],   // 1. this workflow's explicit override for this role
    modeMappings[options.roleSize],         // 2. the global size-tier default
    modeMappings.default,                   // 3. the global default-of-defaults
  ];

  for (const targets of targetLists) {
    if (targets !== undefined && targets.length > 0) {
      return targets; // first non-empty list wins, tried in this order
    }
  }

  throw new StepKitFailureError({ code: "agent_targets_unavailable", /* ... */ });
}
```

This 3-tier fallback order (workflow-specific → size → default) is **not changing** — this feature
only changes *how each of those three things is expressed and stored*, not the precedence order
between them.

### Current parse pipeline (validates raw JSON into the typed `StepKitConfig` above)

Directory: `packages/core/src/agent-targeting/parse-stepkit-config/`

Entry point `parse-stepkit-config.ts`, exact call order, step by step:

```ts
export function parseStepKitConfig(value: unknown): StepKitConfig {
  const diagnostics: string[] = [];              // 1. shared array, every sub-parser pushes into it

  if (!isRecord(value)) {                         // 2. must be a plain object at all
    throwValidationFailure(["config must be an object."]);
  }

  if (value.version !== 1) {                      // 3. push, don't throw yet
    diagnostics.push("version must be 1.");
  }

  const customAgents = parseCustomAgents(value.customAgents, diagnostics);       // 4
  const providerNames = new Set(Object.keys(customAgents));                     // 5
  const workingAgents = parseSizeAgentMappings("workingAgents", value.workingAgents, diagnostics);       // 6
  const interactiveAgents = parseSizeAgentMappings("interactiveAgents", value.interactiveAgents, diagnostics); // 7
  const workflows = parseWorkflows(value.workflows, diagnostics);                // 8

  if (diagnostics.length > 0) {                    // 9. GATE: stop here if any shape errors so far
    throwValidationFailure(diagnostics);
  }

  validateProviderReferences({ workingAgents, interactiveAgents, workflows, providerNames }); // 10. separate check, separate throw

  return { version: 1, customAgents, workingAgents, interactiveAgents, ...(workflows === undefined ? {} : { workflows }) }; // 11
}
```

**Why this order matters and must be preserved as a pattern**: steps 2-8 only check *shape* (is
this the right JSON type, is this a valid enum value?) and never throw individually — they push a
human-readable sentence onto `diagnostics` and return a safe default (`{}`, `[]`, etc.) so every
other sibling parser still gets a chance to run and report its own problems in the *same* error
message. Only step 9 (the gate) throws, and only once, with every accumulated problem listed
together. Step 10 is a *second*, separate kind of check — not "is this shaped right" but "does this
value actually refer to something real" (does this provider name exist?) — and it only runs after
step 9 has confirmed everything is shape-valid, since it would be meaningless to cross-check
references in data that isn't even well-formed yet. **You must add the new ref-checking logic as a
third phase, after step 10, for exactly the same reason**: it doesn't make sense to check whether a
`{ref: "workerA"}` points at something real until you already know every provider reference is
valid.

Per-file breakdown of that pipeline (all in the same directory):

- **`parse-custom-agents.ts`** — validates `customAgents`: each entry needs a non-empty string
  `binary`; optional `args` (string array), `cwd` (string), `env` (string-to-string record).
- **`parse-size-agent-mappings.ts`** — validates `workingAgents`/`interactiveAgents`: each key must
  be one of the 6 reserved size names (checked against `AGENT_SIZES`, a `Set` exported from
  `parse-agent-targets.ts`); each value is parsed by `parseTargetArray`.
- **`parse-workflow-agent-mappings.ts`** — validates `workflows`: for each workflow id, parses its
  `workingAgents`/`interactiveAgents` role maps (any string key allowed here — role names are
  workflow-author-defined, not restricted to the 6 sizes), each value again via `parseTargetArray`.
- **`parse-agent-targets.ts`** — the leaf validator, `parseTargetArray(path, value, diagnostics)`:
  checks `value` is an array; for each element, checks it's an object with a non-empty string
  `provider` (drops the element entirely if not — this is the *only* field whose failure drops the
  whole element); validates optional `model` (string), `thinking` (one of the 5 enum values),
  `args` (string array) — these three only *warn* on bad type, they don't drop the element, they
  just omit that one bad field from the result.
- **`parse-utils.ts`** — shared helpers: `isRecord` (plain-object type guard), `throwValidationFailure`
  (wraps a `StepKitFailureError` with `code: "validation_failed"`), `parseOptionalStringArray`,
  `parseOptionalStringRecord`.
- **`validate-provider-references.ts`** — the semantic (not shape) cross-check: walks the
  already-parsed `workingAgents`/`interactiveAgents`/`workflows` structures and, for every target's
  `provider` field, checks it's either a built-in registry key (`isProviderRegistryKey`, from
  `packages/core/src/known-cli-providers/registry/provider-registry.ts`) or a key present in
  `customAgents`. Collects violations, throws once with `code: "agent_provider_unknown"`.

**Failure shape convention** — `packages/core/src/contracts/failures/failure.ts`:

```ts
export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}
export class StepKitFailureError extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) { super(failure.message); this.name = "StepKitFailureError"; this.failure = failure; }
}
```

Multi-error validation failures put every accumulated problem string into `details: { diagnostics:
string[] }`. Each diagnostic sentence follows this exact style — copy it precisely for any new
diagnostic message you add:

- Starts with a path: dot for object keys (`customAgents.workerA.binary`), `[i]` for array indices
  (`workingAgents.large[0].provider`).
- Ends with a period.
- Required-field failures: `"<path> must be a non-empty string."` (no qualifier).
- Optional-field failures: `"<path> must be a string when present."` (note the "when present").
- Enum mismatches spell out every allowed value: `"<path> must be one of low, medium, high, xhigh, or max when present."`
- Cross-reference failures name the bad value inline with single quotes: `"<path> references
  unknown provider 'foo'. Declare it under customAgents or use a built-in provider."`

**There is no existing code anywhere in this repo for detecting cycles in a self-referential
structure.** This has been confirmed by reading every file in this parse pipeline plus the resolve
and execution code. You are building this from scratch. Only the *surrounding* conventions above
(diagnostics array, message style, gate-then-separate-throw pattern) have precedent — the actual
graph-walk/visited-set logic does not exist yet anywhere to copy from.

### Current execution layer (what actually spawns a provider process)

Files: `packages/core/src/agent-execution/working-agent/run-working-agent-command/run-working-agent-command.ts`
and `.../interactive-agent/run-interactive-agent-command/run-interactive-agent-command.ts`.

Both: call `resolveAgentTargets(...)`, get back an ordered fallback-chain array, try each target in
order (catching failures and moving to the next), and for each target:
- If `target.provider` is a built-in registry key: call `providerRegistry[target.provider].runWorking(...)`
  or `.runInteractive(...)` — the adapter itself knows how to invoke that CLI in either mode, no
  extra config needed from the user.
- Else, look up `config.customAgents[target.provider]` (a hand-configured binary): build argv from
  its `args` template by substituting placeholders.

**The one place mode genuinely forces different config**: custom-agent argv placeholders differ.
Working mode substitutes `{{promptFile}}`, `{{outputFile}}`, `{{model}}`. Interactive mode
substitutes `{{prompt}}`, `{{promptFile}}`, `{{model}}` — **there is no `{{outputFile}}` in
interactive mode at all**, because interactive steps hand off to a live human/agent session with
inherited stdio, not a file the process writes and exits. A custom binary's argv template built for
one mode literally cannot serve the other mode as-is. This is why `customAgents` (soon
`customProviders`) needs *two* separate optional argv templates, not one shared with the built-in
providers (which need zero extra config either way, since their adapters handle both modes
internally already).

Thinking resolution, `run-working-agent-command.ts`:
```ts
function resolveWorkingThinking(target: StepKitAgentTarget, role: WorkflowAgentRole): WorkflowAgentRole["thinking"] {
  return target.thinking ?? role.thinking; // the config-level override wins; the workflow author's hint is only a fallback
}
```
This logic is correct today and **is not changing** in this feature.

### Current scope-file merge behavior

File: `packages/cli/src/internals/config/config.ts`, function `loadStepKitProjectConfig`:

```ts
export async function loadStepKitProjectConfig(cwd = process.cwd()): Promise<StepKitProjectConfig> {
  const [base, local] = await Promise.all([
    readRawStepKitConfig(join(cwd, ".stepkit", "config.json"), { description: ".stepkit/config.json" }),
    readRawStepKitConfig(join(cwd, ".stepkit", "config-local.json"), { description: ".stepkit/config-local.json" }),
  ]);
  // ...
  const merged = mergeRawStepKitConfig(base, local);
  // ... parseStepKitConfig(toCoreStepKitConfigValue(merged)) ...
}

function mergeRawStepKitConfig(base: unknown, local: unknown): unknown {
  if (!isRecord(base)) return local ?? base;
  if (!isRecord(local)) return base;
  return { ...base, ...local }; // SHALLOW spread: a key present in `local` replaces base's value for that key ENTIRELY
}
```

**Confirmed gap you must fix**: `~/.stepkit/config.json` (user scope) is read *only* by
`loadStepKitUserWorkflowRegistry`, and that function extracts *only* the `workflows` registry map
(the namespace→name→ref-string lookup used to resolve `user/foo`-style workflow references) — it
never feeds into `parseStepKitConfig`/`StepKitConfig` at all. **User-scope agent-targeting config
(`customAgents`/`workingAgents`/`interactiveAgents` today, `customProviders`/`agents` after this
feature) is completely inert right now — writing it into `~/.stepkit/config.json` has zero effect
on any workflow run.** You must build a genuinely new three-way merge to fix this, since there is no
existing two-of-three-scope precedent to extend other than the base+local pair shown above.

**Also confirmed**: `.stepkit/config-local.json` is **not** yet listed in the root `.gitignore` —
this is sub-feature "0" below, completely independent of everything else.

### Current CLI command registration

File: `packages/cli/src/internals/command-registry.ts` (37 lines, reproduced in full since you'll
be editing it):

```ts
import type { CliCommand } from "./command.types.js";
import { addCommand } from "./commands/add/add-command.js";
import { cancelCommand } from "./commands/cancel/cancel-command.js";
import { continueCommand } from "./commands/continue/continue-command.js";
import { listCommand } from "./commands/list/list-command.js";
import { runCommand } from "./commands/run/run-command.js";
import { skillCheckCommand } from "./commands/skill-check/skill-check-command.js";

/**
 * Resolves the CLI command implementation for a given argv.
 * This is the only file that needs to change to register a new command.
 */
export function resolveCommand(argv: readonly string[]): CliCommand<unknown> {
  if (argv[0] === "add") return addCommand;
  if (argv.length === 1 && argv[0] === "list") return listCommand;
  if (argv.length === 1 && argv[0] === "skill-check") return skillCheckCommand;
  if (argv[0] === "continue") return continueCommand;
  if (argv[0] === "cancel") return cancelCommand;
  return runCommand; // fallback: treat argv[0] as a workflow ref
}
```

Minimal command-module template to copy, `packages/cli/src/internals/commands/skill-check/skill-check-command.ts`
(reproduced in full):

```ts
import { type CliCommand, type CliCommandContext, CliUsageError } from "../../command.types.js";
import { discoverWorkflows } from "../../discovery/discovery.js";
import { findPackagesMissingSkills } from "./skill-detection.js";

export const skillCheckCommand: CliCommand<Record<string, never>> = {
  name: "skill-check",
  parseArgs(argv: readonly string[]): Record<string, never> {
    if (argv.length !== 1 || argv[0] !== "skill-check") {
      throw new CliUsageError("Expected skill-check.");
    }
    return {};
  },
  async run(_args, context: CliCommandContext): Promise<number> {
    const workflows = await discoverWorkflows({ cwd: context.cwd });
    const reports = await findPackagesMissingSkills(workflows);
    for (const report of reports) {
      context.io.writeLine(`Missing SKILL.md for ${report.packageName}: ${report.workflowIds.join(", ")}`);
    }
    return 0;
  },
};
```

Every new command file follows this exact shape: `export const xCommand: CliCommand<TArgs> = {
name, parseArgs, run }`. `parseArgs` throws `CliUsageError` (imported from `command.types.ts`) on
bad input. `run` returns a numeric exit code (`0` success, `1` failure via a thrown known error type
caught in `packages/cli/src/index.ts`'s `main()`).

### Current prompt primitives (and why they're not enough for `stepkit agents`)

Interface, `packages/cli/src/internals/command.types.ts`:

```ts
export interface StepkitCliPrompts {
  text: (prompt: string) => Promise<string>;
  select: (prompt: string, choices: readonly string[]) => Promise<string>;
}
```

Real implementation, `packages/cli/src/index.ts`, function `createTerminalPrompts()` — a homegrown
`node:readline/promises` wrapper. `select` prints a numbered list (`1) foo`, `2) bar`) and parses a
typed integer answer. **There is no arrow-key navigation, no nested/hierarchical menu, no
multi-select anywhere in this codebase.** Confirmed via full grep of `package.json`/`pnpm-lock.yaml`
across the whole monorepo for `@clack`, `prompts`, `enquirer`, `inquirer` — zero hits, no TUI
library installed anywhere.

**Decision, confirmed with the user**: add **`@clack/prompts`** as a new dependency in
`packages/cli/package.json`. It's lightweight (no dependencies of its own), ESM-native (matches this
package's `"type": "module"`), and provides real arrow-key single-select, confirm, and text prompts
out of the box. This was chosen over (a) hand-rolling raw-mode keypress handling ourselves (more
code to own, cross-platform quirks on Windows vs. macOS/Linux) and (b) shipping the `stepkit agents`
nested-menu UX as flat numbered lists only (functional but not real arrow-key nav).

Test-fake convention to follow for anything new, from `packages/cli/src/internals/commands/add/add-command.test.ts`
(pattern reproduced, this exact shape, not a mock library — plain object literals):

```ts
const exitCode = await command.run(args, {
  cwd,
  io: { writeLine: () => undefined, writeError: () => undefined },
  prompts: {
    select: async (prompt, choices) => {
      if (prompt === "Config scope") {
        expect(choices).toEqual(["project", "project-local", "user"]);
        return "project";
      }
      throw new Error(`Unexpected select prompt: ${prompt}`); // exhaustive-match convention: unhandled prompt = test failure
    },
    text: async (prompt) => {
      if (prompt === "Namespace") return "acme";
      throw new Error(`Unexpected prompt: ${prompt}`);
    },
  },
});
```

Note the throwing default branch in every fake — this both documents every prompt a command can
issue, and fails loudly (rather than silently returning `undefined`) if the command asks something
the test didn't expect.

### Current model/provider enumeration (there is none)

Confirmed via full grep of `packages/core` and `packages/cli` for model-name-shaped strings
(`opus`, `sonnet`, `haiku`, `gpt-5`, etc.) outside of test fixtures: **no curated list of valid
model names exists anywhere, for any provider.** `model` is always a bare, unvalidated `string`
passed straight through to the spawned CLI (e.g. `claude-provider.ts`: `if (request.model) {
args.push("--model", request.model); }`). Codex is the one exception that validates *anything*
provider-side, and it's `thinking`, not `model` — a hardcoded `Set(["low","medium","high","xhigh"])`
(no `"max"` — codex doesn't support that tier) in `codex-provider.ts`. **When you build any "pick a
model" prompt, it must be free-text input** (`prompts.text`, or `@clack/prompts`'s `text`), not a
picker over a list — there is nothing to enumerate from.

Built-in provider ids (fixed, will not change): `claude`, `codex`, `pi`, `gemini` — from
`packages/core/src/known-cli-providers/registry/provider-registry.ts`.

### Current `stepkit add` and what it already loads

File: `packages/cli/src/internals/commands/add/add-command.ts`. Already, as part of validating a
**direct-file** workflow source, calls `loadDirectWorkflowFile(args.source, { cwd })` and gets back
the actual loaded `workflow` object in memory — so `workflow.agents` (the role map) is already
available with zero extra cost for this source type. For a **bundle** source (a package with a
`stepkit.workflows` manifest), today it only reads workflow *names* out of `package.json` via
`readBundleWorkflowNames` — it does **not** import the module, so `workflow.agents` is not
available yet for this source type; you'll need to add that import step (mirroring the skill
generation code a few lines later in the same file, which already does a bundle import via
`loadBundleWorkflow`).

The command already has an established dual-mode pattern worth copying exactly: `resolveInteractiveArgs`
checks whether each required value was passed as a flag; if not, and `context.prompts` exists, it
prompts; if not and there's no prompts context either, it throws a `CliUsageError` demanding the
flag. This is the convention for every new interactive flow: **flags first, prompt as fallback,
clear error if neither is available.**

---

## Sub-feature 0: `.gitignore` fix

**Do this first, independently of everything else.**

1. Open the root `.gitignore`.
2. Add a line: `.stepkit/config-local.json` (or a broader `.stepkit/*.local.json` pattern if you
   want to future-proof for other per-machine files — either is fine, just make sure the literal
   current filename is covered).
3. Confirm it's not already tracked: run `git status` — if `.stepkit/config-local.json` shows up as
   a tracked file anywhere in the repo (it shouldn't, since this is a fresh feature, but check), you
   would additionally need `git rm --cached` it; expect this not to be necessary.

LOE: 5 minutes.

---

## Sub-feature 1: Core schema rewrite (`@stepkit/core`)

This is the foundation. Nothing else in this document can be built correctly until this lands.

### 1.1 — Rename `customAgents` → `customProviders`, add `interactiveArgs`

**Why**: `customAgents` is a misleading name — it doesn't configure an "agent" (a role/size/target
mapping), it registers a raw CLI *provider* binary, exactly parallel to the built-in `claude`/
`codex`/`pi`/`gemini` providers. Renaming makes the vocabulary consistent: providers are things you
run; agents are named configurations of provider+model+thinking.

**Exact new type**, `packages/core/src/agent-targeting/targeting.types.ts`:

```ts
export interface StepKitCustomProviderConfig {
  readonly binary: string;
  readonly args?: readonly string[];           // working-mode argv template (was just "args")
  readonly interactiveArgs?: readonly string[]; // NEW: interactive-mode argv template
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}
```

**Files to change** (every one of these currently says `customAgents`/`CustomAgent`, rename to
`customProviders`/`CustomProvider`):
- `packages/core/src/agent-targeting/targeting.types.ts` — the interface itself, plus
  `StepKitConfig.customAgents` → `StepKitConfig.customProviders`.
- `packages/core/src/agent-targeting/parse-stepkit-config/parse-custom-agents.ts` — rename the
  file itself to `parse-custom-providers.ts`, rename the exported function `parseCustomAgents` →
  `parseCustomProviders`. Add validation for the new optional `interactiveArgs` field — copy the
  existing `args` validation exactly (`parseOptionalStringArray`), just for the new field name.
- `packages/core/src/agent-targeting/parse-stepkit-config/parse-stepkit-config.ts` — update the
  import and the call site (`value.customAgents` → `value.customProviders`).
- `packages/core/src/agent-targeting/parse-stepkit-config/validate-provider-references.ts` — the
  `providerNames` set is still built the same way, just from `customProviders`'s keys instead of
  `customAgents`'s.
- `packages/core/src/agent-execution/working-agent/run-working-agent-command/run-working-agent-command.ts` —
  every `options.config.customAgents[...]` lookup → `options.config.customProviders[...]`. Uses
  `agentConfig.args` (unchanged field name, now explicitly "working template").
- `packages/core/src/agent-execution/interactive-agent/run-interactive-agent-command/run-interactive-agent-command.ts` —
  same lookup rename. **Must now use `agentConfig.interactiveArgs` instead of `agentConfig.args`**
  when building the interactive argv. If `interactiveArgs` is `undefined` for a custom-provider
  target being used in interactive mode, throw a new clear failure — do not silently fall back to
  the working-mode `args` template (its placeholders are wrong for interactive mode, see the
  Current-state section above). Suggested new error:
  ```ts
  throw new StepKitFailureError({
    code: "agent_provider_interactive_unsupported",
    message: `Custom provider '${target.provider}' has no interactiveArgs configured and cannot be used for an interactive step.`,
    details: { provider: target.provider },
  });
  ```
- `packages/cli/src/internals/config/config.ts` — the `toCoreStepKitConfigValue` default-fill
  function currently does `customAgents: value.customAgents ?? {}`; change the key name to
  `customProviders: value.customProviders ?? {}`.
- Any test file referencing `customAgents` in a fixture (search-and-rename across `*.test.ts`).

### 1.2 — Unify `workingAgents`/`interactiveAgents` into one `agents` map

**Why**: confirmed above, built-in providers need zero extra config to serve both modes, and the
one place mode genuinely differs (custom-provider argv templates) is now handled per-field
(`args` vs `interactiveArgs`) inside `StepKitCustomProviderConfig`, not by duplicating the entire
size/role mapping structure. This removes a whole layer of config duplication.

**Exact new types**:

```ts
export interface StepKitAgentTarget {
  readonly provider: string;
  readonly model?: string;
  readonly thinking?: WorkflowAgentThinking;
  readonly args?: readonly string[];
}
// UNCHANGED — this shape stays exactly as-is.

export type StepKitAgentMappings = Readonly<Record<string, readonly StepKitAgentTarget[]>>;
// Replaces BOTH StepKitSizeAgentMappings and StepKitRoleAgentMappings — after this change there is
// only ONE kind of mapping shape (a plain string-keyed map to fallback-chain arrays), because size
// tiers are no longer structurally special at this layer (see 1.3 below) and working/interactive
// are no longer separate maps.

export interface StepKitWorkflowConfig {
  readonly agents?: StepKitAgentMappings; // replaces workingAgents + interactiveAgents (both removed)
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface StepKitConfig {
  readonly version: 1;
  readonly customProviders: Readonly<Record<string, StepKitCustomProviderConfig>>;
  readonly agents: StepKitAgentMappings; // replaces workingAgents + interactiveAgents (both removed)
  readonly workflows?: Readonly<Record<string, StepKitWorkflowConfig>>;
}
```

**`resolveAgentTargets` simplification** — the `mode` field disappears from its options entirely,
since there's only one map to read now:

```ts
export interface ResolveAgentTargetsOptions {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly roleSize: WorkflowAgentSize;
  // mode: REMOVED — no longer needed for the lookup itself
}

export function resolveAgentTargets(options: ResolveAgentTargetsOptions): readonly StepKitAgentTarget[] {
  const workflowMappings = options.config.workflows?.[options.workflowId]?.agents;
  const targetLists = [
    workflowMappings?.[options.roleName],
    options.config.agents[options.roleSize],
    options.config.agents.default,
  ];
  for (const targets of targetLists) {
    if (targets !== undefined && targets.length > 0) return targets;
  }
  throw new StepKitFailureError({ code: "agent_targets_unavailable", /* ... */ });
}
```

Both call sites (`run-working-agent-command.ts`, `run-interactive-agent-command.ts`) drop `mode`
from the object they pass into `resolveAgentTargets(...)`. They still know their own mode from
their own context (one file only ever runs working steps, the other only interactive) — they use
that knowledge only for (a) which provider method to call (`runWorking` vs `runInteractive`) and
(b) which custom-provider argv field to use (`args` vs `interactiveArgs`), both of which already
happen further down in each file's own logic, unrelated to `resolveAgentTargets`.

**Files that no longer need to exist**: `parse-size-agent-mappings.ts`'s job (validate that keys are
one of the 6 reserved size names) goes away — see 1.3 below, any string key is now allowed at parse
time, size names become purely a CLI-level convention. You can delete this file, or repurpose it —
your call, but do not keep dead code around.

### 1.3 — New authoring-time schema: `items` list of literal-or-ref

**Why**: this is the actual new feature — let any named agent, size tier, or workflow role mapping
be built from an ordered list where each element is *either* a literal target *or* a pointer to
another named agent, so you can define an agent once (e.g. `"workerA"`) and reuse it everywhere
instead of copy-pasting the same target JSON repeatedly.

**Exact new raw-JSON shape** (this is what a human, or the CLI on their behalf, writes into
`.stepkit/config.json`):

```json
{
  "version": 1,
  "customProviders": {
    "my-custom-cli": {
      "binary": "my-agent",
      "args": ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
      "interactiveArgs": ["--prompt", "{{prompt}}"]
    }
  },
  "agents": {
    "default":  { "items": [{ "provider": "claude", "model": "sonnet" }] },
    "small":    { "items": [{ "ref": "workerA" }] },
    "medium":   { "items": [{ "ref": "workerA" }] },
    "large":    { "items": [{ "provider": "codex", "model": "gpt-5", "thinking": "high" }] },
    "workerA":  { "items": [{ "provider": "claude", "model": "haiku" }] },
    "workerB":  { "items": [{ "provider": "codex", "model": "gpt-5" }, { "ref": "workerA" }] }
  },
  "workflows": {
    "project/review": {
      "agents": {
        "reviewer": { "items": [{ "ref": "workerB" }] },
        "implementor": { "items": [{ "provider": "claude", "model": "opus" }] }
      }
    }
  }
}
```

Walk through what `workerB` means above: "try codex/gpt-5 first; if that fails, fall back to
whatever `workerA` currently resolves to (which is itself claude/haiku)." That's ref-expansion:
`workerB`'s effective fallback chain, once resolved, is `[codex/gpt-5, claude/haiku]` — two literal
targets, even though only one was written by hand.

**New parse-time types** (these are intermediate/raw types, used only inside the parse pipeline —
they do NOT appear on the final `StepKitConfig` returned to callers, see 1.4 below for why):

```ts
// New file: packages/core/src/agent-targeting/parse-stepkit-config/agent-item.types.ts (or inline
// in parse-agent-items.ts — your call on file split, keep it small)
export type RawAgentItem = { readonly ref: string } | StepKitAgentTarget;
export interface RawAgentEntry { readonly items: readonly RawAgentItem[]; }
```

**New/changed parse file** — replace `parse-agent-targets.ts`'s `parseTargetArray` (which parsed a
bare array of literal targets) with something that parses an `items` array where each element is
*either* `{ref: string}` *or* a literal target. Suggested shape:

```ts
// parse-agent-targets.ts, updated
export function parseAgentEntry(path: string, value: unknown, diagnostics: string[]): RawAgentEntry {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return { items: [] };
  }
  if (!Array.isArray(value.items)) {
    diagnostics.push(`${path}.items must be an array.`);
    return { items: [] };
  }
  const items = value.items.flatMap((item, index): RawAgentItem[] => {
    const itemPath = `${path}.items[${index}]`;
    if (!isRecord(item)) {
      diagnostics.push(`${itemPath} must be an object.`);
      return [];
    }
    if (typeof item.ref === "string") {
      if (item.ref.length === 0) {
        diagnostics.push(`${itemPath}.ref must be a non-empty string.`);
        return [];
      }
      return [{ ref: item.ref }]; // no other fields checked — a ref item is just a pointer
    }
    // fall through to existing literal-target validation (provider/model/thinking/args) —
    // this is the SAME logic that currently lives in parseTargetArray's per-element body, just
    // reused here for the "not a ref" branch. Do not duplicate it — extract it into a small
    // `parseLiteralTarget(itemPath, item, diagnostics): StepKitAgentTarget[]` helper and call it
    // from both the old array-based caller (if any survives) and this new items-based caller.
    return parseLiteralTarget(itemPath, item, diagnostics);
  });
  return { items };
}
```

**New unified map parser** — replaces `parse-size-agent-mappings.ts` AND the role-mapping half of
`parse-workflow-agent-mappings.ts` (both become one function, since there's no longer a
size-vs-role structural distinction — any string key is valid):

```ts
export function parseAgentMappings(
  path: string,
  value: unknown,
  diagnostics: string[],
): Record<string, RawAgentEntry> {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return {};
  }
  const mappings: Record<string, RawAgentEntry> = {};
  for (const [name, entry] of Object.entries(value)) {
    mappings[name] = parseAgentEntry(`${path}.${name}`, entry, diagnostics);
  }
  return mappings;
}
```

Called as `parseAgentMappings("agents", value.agents, diagnostics)` for the top-level map, and
`parseAgentMappings(`workflows.${workflowId}.agents`, workflow.agents, diagnostics)` per workflow
inside `parse-workflow-agent-mappings.ts`.

**`AGENT_SIZES`** (the `Set` of the six reserved size names, currently exported from
`parse-agent-targets.ts`): keep the constant around (it's still useful for the CLI layer's display
logic — "these six names are always shown as rows even if unset" — see sub-feature 4), but it is
**no longer used inside the parser** to reject non-size keys in the top-level `agents` map. Any
string key is a valid entry name now (that's the whole point — custom names like `workerA` live
alongside size names in the same map with no special-casing).

### 1.4 — Flatten refs at parse time (key architectural decision)

**This is the single most important design decision in this whole feature. Read this section
twice before writing any code.**

**The decision**: `parseStepKitConfig` must fully resolve every `{ref: name}` item into the literal
target(s) it points to, **before** it returns. The final `StepKitConfig.agents` and
`StepKitConfig.workflows[id].agents` that come out of `parseStepKitConfig` contain **only plain
arrays of literal `StepKitAgentTarget` objects** — exactly the same shape they are today. No
`{ref}`, no `items`, no `RawAgentEntry` — those types exist *only* inside the parse pipeline, as an
intermediate step, never in the final returned config.

**Why this matters**: it means `resolve-agent-targets.ts` and both execution files
(`run-working-agent-command.ts`, `run-interactive-agent-command.ts`) need **zero changes** for
ref-handling — they already just consume `Record<string, readonly StepKitAgentTarget[]>`, which is
exactly what they'll keep getting. All of the new complexity (chained refs, cycle detection) is
fully contained inside the parse pipeline, in one place, and every other layer of the system stays
exactly as simple as it is today. This matches an existing rule already written down in
`.pi/rules/packages/cli/src/internals/config/config.md`: *"Config shape and provider/target
diagnostics are owned by `@stepkit/core`; this [CLI] layer should format, not duplicate, validation
policy."* We're extending that same idea one layer further down: parsing should fully resolve
policy so execution never has to know about it.

**The type returned by `parseStepKitConfig` is therefore, in full, exactly what's shown in section
1.2 above** — `StepKitConfig.agents: StepKitAgentMappings` (a plain `Record<string, readonly
StepKitAgentTarget[]>`), nothing more exotic.

**Algorithm** (new function, e.g. `expandAgentRefs` in a new file
`validate-and-expand-agent-refs.ts`, called from `parse-stepkit-config.ts` right after
`validateProviderReferences`):

```
function expandAgentRefs(rawAgents: Record<string, RawAgentEntry>): Record<string, StepKitAgentTarget[]> {
  // Step A: check every {ref} names a real key BEFORE trying to expand anything.
  //   For every entry, for every item that is a {ref: name}: if `name` is not a key in
  //   rawAgents, push a diagnostic like:
  //     "agents.<entryName>.items[<i>].ref references unknown agent 'name'."
  //   If any such diagnostics were collected, throw ONE StepKitFailureError,
  //     code: "agent_ref_unknown", details: { diagnostics }
  //   (Same pattern as validate-provider-references.ts's existing throw — collect first, throw once.)

  // Step B: depth-first expand each entry, with cycle detection.
  const resolved = new Map<string, StepKitAgentTarget[]>(); // memoized results, avoids re-expanding shared refs repeatedly
  const cycleDiagnostics: string[] = [];

  function expand(name: string, visited: Set<string>): StepKitAgentTarget[] {
    if (resolved.has(name)) return resolved.get(name)!;      // already fully expanded earlier, reuse it
    if (visited.has(name)) {                                  // we're already in the middle of expanding this same name
      cycleDiagnostics.push(`agents.${name} is part of a reference cycle: ${[...visited, name].join(" -> ")}.`);
      return []; // return empty so the caller doesn't also crash; the throw below is what actually stops execution
    }
    const nextVisited = new Set(visited).add(name);
    const entry = rawAgents[name]; // guaranteed to exist by Step A's check
    const expandedItems = entry.items.flatMap((item) =>
      "ref" in item ? expand(item.ref, nextVisited) : [item] // splice the referenced entry's own expanded items in-place
    );
    resolved.set(name, expandedItems);
    return expandedItems;
  }

  for (const name of Object.keys(rawAgents)) {
    expand(name, new Set());
  }

  if (cycleDiagnostics.length > 0) {
    throw new StepKitFailureError({ code: "agent_ref_cycle", details: { diagnostics: cycleDiagnostics }, /* ... */ });
  }

  return Object.fromEntries(resolved);
}
```

**Worked example of the cycle case** — if a user writes:
```json
{ "agents": { "workerA": { "items": [{ "ref": "workerB" }] }, "workerB": { "items": [{ "ref": "workerA" }] } } }
```
Expanding `workerA`: `visited = {}` → add `workerA` → `visited = {workerA}` → its one item refs
`workerB` → expand `workerB` with `visited = {workerA}` → add `workerB` → `visited =
{workerA, workerB}` → its one item refs `workerA` → expand `workerA` with `visited = {workerA,
workerB}` → **`workerA` is already in `visited`** → cycle detected, diagnostic pushed:
`"agents.workerA is part of a reference cycle: workerA -> workerB -> workerA."` → after the full
loop over all top-level names finishes, the accumulated `cycleDiagnostics` is non-empty → throw.

**Apply this same `expandAgentRefs` logic to `workflows.<id>.agents` too** — either by including
those entries in the same `rawAgents` map passed to one call (giving them fully-qualified keys like
`workflows.project/review.agents.reviewer` internally to avoid name collisions with the top-level
map — refs from a workflow role should still be able to point at *top-level* agent names, not
workflow-local ones, so be careful your key-namespacing scheme doesn't accidentally let two
different workflows' same-named role collide with each other or with a top-level agent of the same
name), or by running the expansion twice (once for the top-level map, once per workflow, always
resolving `{ref}` items against the *top-level* map's names, since refs are only ever meant to point
at reusable named agents, never at another workflow's private role mapping). **Recommend the
second approach** — simpler to reason about, and matches the actual intended semantics ("a ref
always points at a reusable named agent," never at another workflow's one-off role).

**New error codes** to add: `agent_ref_unknown` (Step A), `agent_ref_cycle` (Step B). Both use the
existing `{ diagnostics: string[] }` details shape.

### 1.5 — `validate-provider-references.ts` adjustment

This still needs to run, but now walks the **pre-expansion** raw structures (so it can tell literal
items from ref items and only check literal ones — a ref item has no `provider` field to check at
all). Recommended order in `parse-stepkit-config.ts`: shape-gate (unchanged) → `validateProviderReferences`
(checks literal items' `provider` only, skip items that are `{ref}`) → `expandAgentRefs`'s Step A
(unknown-ref check) → `expandAgentRefs`'s Step B (cycle check + actual expansion). This ordering is
a recommendation, not something the user explicitly locked down word-for-word — if you find a
reason to reorder while implementing, that's fine, just keep the "collect diagnostics, throw once
per phase" pattern intact.

### 1.6 — Three-way scope merge (project-local > project > user)

**Why**: today `~/.stepkit/config.json`'s agent config is never read at all (confirmed above) — you
need a genuinely new loader plus a genuinely new merge, since there's no existing three-scope
precedent, only the base+local two-scope one.

**New loader**, `packages/cli/src/internals/config/config.ts`, parallel to the existing
`loadStepKitUserWorkflowRegistry` (which only reads the `workflows` key) — you need one that reads
the **whole** raw JSON object from `~/.stepkit/config.json` (agent config and all), analogous to
how `.stepkit/config.json`/`config-local.json` are read today via `readRawStepKitConfig`.

**New merge function** — do **not** just extend `mergeRawStepKitConfig`'s existing 2-way shallow
spread to 3 arguments naively, because `agents` needs different (deeper) merge behavior than every
other top-level key:

```ts
function mergeThreeScopeConfigs(user: unknown, project: unknown, projectLocal: unknown): unknown {
  const layers = [user, project, projectLocal].filter(isRecord); // lowest to highest precedence, left to right
  if (layers.length === 0) return undefined;

  // Step 1: shallow-merge every key EXCEPT `agents`, same semantics as today (highest-precedence
  // scope's value for a key wins entirely).
  const shallowMerged = layers.reduce((acc, layer) => ({ ...acc, ...layer }), {});

  // Step 2: `agents` specifically deep-merges PER ENTRY NAME across all three layers — a name
  // present in a higher-precedence scope replaces that name's WHOLE entry (its `items` array is
  // the smallest merge unit — not merged item-by-item), but names not overridden survive from a
  // lower-precedence scope.
  const agentsLayers = layers.map((layer) => (isRecord(layer.agents) ? layer.agents : {}));
  const mergedAgents = agentsLayers.reduce((acc, layer) => ({ ...acc, ...layer }), {});

  return { ...shallowMerged, agents: mergedAgents };
}
```

Precedence: **project-local wins over project, which wins over user** — this matches the
`stepkit agents` command's own nav ordering (built in sub-feature 4) and was the clearly-intended
reading, though it hasn't been confirmed in those exact words — implement it this way, flag it if
it turns out to be wrong once a fresh person picks this up.

**Worked example**: user config has `agents.workerA = {items: [claude/haiku]}`. Project config has
`agents.workerA = {items: [claude/sonnet]}` and `agents.workerB = {...}`. Project-local config has
nothing under `agents` at all. Merged result: `agents.workerA` = project's version (claude/sonnet —
project beats user), `agents.workerB` = project's version (survives, nothing overrode it). If
project-local *also* set `agents.workerA`, project-local's version would win instead.

### 1.7 — Tests to add/update

- `resolve-agent-targets.test.ts` — remove all `mode` usage from test setup, since the function no
  longer takes it.
- No dedicated `parse-stepkit-config*.test.ts` exists today (confirmed) — the whole pipeline is
  only tested indirectly through `resolve-agent-targets.test.ts`. Given how novel the ref-expansion
  logic is, add **dedicated** tests for it, e.g. a new `expand-agent-refs.test.ts` covering:
  - a single-level ref expands correctly (`{ref: "workerA"}` → `workerA`'s literal items spliced in).
  - a chained ref expands correctly (A refs B, B refs C, C is literal — expanding A yields C's items).
  - a self-ref (`workerA` refs `workerA`) throws `agent_ref_cycle`.
  - a two-entry cycle (A refs B, B refs A) throws `agent_ref_cycle` with both names in the message.
  - a ref to a nonexistent name throws `agent_ref_unknown`.
  - a workflow role's `{ref}` correctly resolves against the *top-level* `agents` map, not some
    other workflow's roles.
- A new test for the three-way merge (mirroring `workflow-registry-config.test.ts`'s existing
  pattern: temp directories, `writeConfig`/`writeLocalConfig`-style helpers, `.resolves.toMatchObject`
  assertions) covering: `agents` deep-merges per-name across all three scopes; every other key
  (`customProviders`, `workflows`) still shallow-replaces wholesale (a regression guard that this
  didn't accidentally change).
- Update anywhere referencing `customAgents`/`workingAgents`/`interactiveAgents` in test fixtures.

### LOE

~2-3 days total (types + parse pipeline rewrite ~1 day, three-way merge + user-scope loader ~half
day, execution-layer rename + `interactiveArgs` wiring ~half day, tests ~1 day).

---

## Sub-feature 2: Shared CLI flow modules

Build these as standalone, reusable functions/modules **before** wiring a full `stepkit agents`
command UI around them. `stepkit init` and `stepkit add`'s role-prompting both reuse these same
pieces — build once, use three times.

### 2.1 — "Configure one target" flow

A function like `configureAgentTarget(prompts): Promise<StepKitAgentTarget>` that:
1. Prompts for provider — offer the four built-in registry keys (`claude`, `codex`, `pi`, `gemini`)
   plus every existing key in `customProviders`, plus a "define a new custom provider" option (which,
   if chosen, prompts for `binary`/`args`/`interactiveArgs`/`cwd`/`env` and writes a new
   `customProviders` entry before continuing).
2. Prompts for model — **free text** (no list exists to enumerate from, confirmed above; don't try
   to build one).
3. Prompts for thinking — **as its own separate step**, optional, offer the 5 enum values or "skip."
   This is deliberately a distinct prompt from provider/model, not bundled into the same question,
   even though it ends up as a field on the same `StepKitAgentTarget` object — this separation was
   an explicit design goal so thinking reads as its own axis in the UX.

### 2.2 — "Manage an items list" flow

Given an entry's current `items` (each already-resolved to either `{ref, resolvedSummary}` or a
literal target), render each as one line: literal → `"claude / sonnet"`-style summary; ref →
`"→ workerA"`. Offer actions:
- **Add item**: either "pick an existing agent" (shows every name in the current merged `agents`
  map as choices, becomes a `{ref}`) or "create new" (runs 2.1, becomes a literal item).
- **Remove item** (pick one to remove from the list).
- **Reorder items** (fallback order matters — up/down or a full re-sequencing prompt).
- **Edit an item in place**: literal → re-run 2.1 pre-filled with its current values; ref → drill
  into (recursively open this same flow for) the referenced entry, subject to the uniform
  save-confirm rules in 2.3 below.

### 2.3 — Uniform save-confirm step

**This is the single mental model for every terminal edit anywhere in `stepkit agents`/`stepkit
init`/`stepkit add`'s role-prompting — the option set changes by context, but the *shape* of "you
just finished editing something, now say where it goes" never does.** Implement as one function
taking a `context: "named-agent" | "workflow-role-ref" | "workflow-role-one-off" | "new-from-dash"`
parameter (or similar) that returns the right option set and applies whichever is chosen:

| Context | Options offered |
|---|---|
| Named agent, edited directly | `Save to original` / `Create new agent` |
| Workflow role → ref, edited | `Save to original (shared, affects every other referrer)` / `Create new agent (fork — only this role repoints)` / `Save as just a workflow agent (detach to one-off)` |
| Workflow role → inline one-off, edited | `Save to original (update one-off in place)` / `Create new agent (promote to a named entry, role becomes a ref)` |
| Dash/unset row, just created new | `Save as new permanent agent` / `Save as one-off` |

"Create new agent" always additionally prompts for a name (used as the new key in the top-level
`agents` map) and checks it doesn't already collide with an existing name.

### 2.4 — Referrer scanner (for delete-block and rename-auto-update)

A function `findAgentReferrers(name: string, allThreeRawScopeConfigs): Referrer[]` that scans:
- every OTHER top-level `agents` entry's `items` for a `{ref: name}`.
- every `workflows.*.agents.*` role's `items` for a `{ref: name}`, across **all three** scope files
  (project, project-local, user) — not just the file the named agent itself lives in, since a ref
  in one scope file can point at a name defined in a different scope's merged view.

Returns enough info to (a) print a human-readable block message ("workerB is used by:
project/review.reviewer, agents.medium — remove those references first") when deleting, and (b)
rewrite every found occurrence's `ref` value in place when renaming.

**Delete**: if `findAgentReferrers` returns anything non-empty, refuse the delete and print the
list. Never cascade, never force — the user must go detach each referrer first (via that referrer's
own edit flow), then retry the delete.

**Rename**: run `findAgentReferrers`, rewrite every found `{ref: oldName}` to `{ref: newName}`
across whichever of the three files contain them, then rename the entry itself.

### LOE

~1.5 days, folded into sub-feature 4's overall estimate below (this is scaffolding, not separately
shippable).

---

## Sub-feature 3: `stepkit init`

### Steps

1. Create `packages/cli/src/internals/commands/init/init-command.ts`. Export `initCommand:
   CliCommand<InitCommandArgs>` following the `skillCheckCommand` template shown in the
   Current-state section above.
2. `parseArgs`: accept an optional `--scope <project|project-local|user>` flag; if omitted and
   `context.prompts` exists, prompt for it later in `run` (don't prompt inside `parseArgs`, which is
   synchronous and has no access to `context`).
3. `run`:
   a. Resolve scope (flag, or prompt via `@clack/prompts` select if no flag and `context.prompts`
      exists, or throw `CliUsageError` if neither).
   b. Run the "configure one target" flow from 2.1 to build one `StepKitAgentTarget`.
   c. Write it as `agents.default.items = [thatTarget]` into whichever file the resolved scope maps
      to (reuse/extract `configPathForScope`-equivalent logic already in `add-command.ts` — check
      whether it's worth pulling into a shared helper in `config.ts` now that three commands need
      "which file for which scope" instead of just `add`).
   d. Confirm-prompt: "Configure more agents now?" (default **no**). If yes, hand off into
      `stepkit agents`'s entry flow (sub-feature 4) for the same scope, landing on the Named-agents
      view.
4. Register in `command-registry.ts`: add `if (argv[0] === "init") return initCommand;` (order
   doesn't matter relative to the other literal-string branches, just keep it before the
   catch-all `return runCommand;`).
5. Add a usage line to `usageText` in `command.types.ts`, e.g.
   `"  stepkit init [--scope <project|project-local|user>]"`.
6. Write `init-command.test.ts` following the `add-command.test.ts` prompt-fake convention shown
   above.

### Decisions already made — don't relitigate

- `init` writes **only** `agents.default` by default — a single quick-start target, config only, no
  example workflow file gets scaffolded. Both explicitly chosen by the user over richer
  alternatives earlier in the design conversation.

### LOE

~4-6 hours — build this after (or alongside) sub-feature 2's shared modules exist, since it's
almost entirely composition of those pieces plus command-registration boilerplate.

---

## Sub-feature 4: `stepkit agents` (the largest single piece)

### Outer structure

Three scope sections, always in this fixed order: **project-local, project, user**. Each section
shows **only that scope file's own raw content** — never a merged/effective view. If a size tier or
workflow role isn't explicitly set in *this* file, show it as a dash row regardless of whether some
other scope would supply a fallback. This was an explicit simplification the user chose specifically
to avoid needing a separate per-row scope indicator — "not set here" is unambiguous and matches
exactly which file an edit would write to.

### Subsection 1: Named agents

Order: custom-named entries first (alphabetical or insertion order — pick one, be consistent),
**then** the six reserved size-tier names below them (`default`, `tiny`, `small`, `medium`,
`large`, `xl` — always shown as rows even if this scope file doesn't set them, displayed as a dash
if unset). Bottom row: `+ Create new agent`.

- **Select a set entry** → offer `Edit` / `Delete` / `Rename`.
  - `Delete` → run the referrer scanner (2.4); if non-empty, show the block message and refuse;
    else remove the entry.
  - `Rename` → run the referrer scanner (2.4), rewrite every found reference, then rename.
  - `Edit` → open the "manage items list" flow (2.2) for this entry; every terminal edit inside that
    flow ends in the uniform save-confirm (2.3) using the "Named agent, edited directly" row.
- **Select `+ Create new agent`** → prompt for a name (check for collisions), open the items-list
  flow (2.2) for a fresh empty entry, ending in save-confirm using the "Dash/unset row" row's
  options minus the one-off choice (there is no workflow-role context here, so only `Save as new
  permanent agent` applies).

### Subsection 2: Workflow agents

Below Named agents. Enumerate every workflow with declared roles by loading each registered
workflow's module and reading `workflow.agents: Record<string, WorkflowAgentRole>` — reuse the
exact same module-loading path `add-command.ts` already uses for skill generation (don't write a
second loader). Per workflow, per declared role, show the role name and this scope file's current
mapping for it: a ref name, a one-off summary, or a dash (dash = "not explicitly set in this scope
file," **not** "broken" — the role may well still resolve fine via a size/default fallback from a
lower-precedence scope or the global tiers).

- **Select a dash row** → offer `Pick existing agent` (browse the Named-agents list from Subsection
  1, becomes a `{ref}`) or `Create new` (opens items-list flow 2.2 for a fresh one-off, ending in
  save-confirm's "Dash/unset row, just created new" options — both `Save as new permanent agent` and
  `Save as one-off` apply here, unlike the Named-agents "+ Create new agent" case above, because
  this DOES have workflow-role context).
- **Select a set row that's a `{ref}`** → offer `Edit` (opens items-list flow 2.2 on the
  *referenced* entry, since it's shared — editing here really means editing the shared agent) /
  `Remove` (clears this role's override in this scope file, falls back to size/default) / `Replace`
  (re-run the pick-existing-or-create-new choice from the dash-row flow). Any edit-through ends in
  save-confirm using the full "Workflow role → ref, edited" three-option row.
- **Select a set row that's an inline one-off** → offer `Edit` (items-list flow 2.2 on the inline
  items directly) / `Remove` / `Replace`. Ends in save-confirm using the "Workflow role → inline
  one-off, edited" two-option row.

### Non-interactive / flag mode

Mirror `stepkit add`'s existing dual-mode convention: interactive when `context.prompts` exists and
flags are omitted, otherwise require explicit flags (throw `CliUsageError` naming exactly what's
missing). Rough command shape (design the exact flags while building, not fully locked yet):
```
stepkit agents set <name> --provider <p> --model <m> [--thinking <t>] --scope <scope>
stepkit agents delete <name> --scope <scope>
stepkit agents rename <old> <new> --scope <scope>
```

### Decisions already made — all confirmed by the user across the design conversation, don't relitigate

- Scope is the outer nav container, fixed order project-local/project/user, each showing only its
  own raw file, never a merged view.
- Custom-named agents listed before size tiers within Named-agents.
- Delete is always blocked-with-referrer-list — never cascading, never forced.
- Rename auto-updates every ref across all three scope files.
- The uniform save-confirm pattern (2.3) is the single mental model for every save action — option
  set varies only by entry point, never the underlying shape of the question.
- Item-list-of-ref-or-literal (`items`) is the schema for **every** entry, no exceptions — named
  agents, size tiers, and workflow role overrides all use the exact same shape. This was an
  explicit, deliberate simplification the user chose ("one mental model to map") over a narrower
  alternative where only the top-level entry could be a ref XOR a plain literal list.
- `@clack/prompts` is the chosen dependency for real arrow-key menus.

### LOE

Largest single piece of CLI work: ~3-5 days (shared items-list UI + uniform confirm step ~1.5
days, counted once and shared with sub-feature 2's estimate; Named-agents subsection ~half day;
Workflow-agents subsection incl. workflow-role discovery/loading ~1 day; non-interactive flag mode
~1 day; tests throughout ~1.5-2 days). TUI-heavy code is normally harder to test than pure logic —
test the underlying pure logic (merge, ref-resolution-for-display, referrer-scanning) independently
of the `@clack/prompts` rendering layer wherever you can, reserving the plain-object prompt-fake
pattern (shown above) for the thin prompt-calling glue only.

---

## Sub-feature 5: `stepkit add` role-prompting integration

### Steps

1. In `add-command.ts`, after the existing workflow-registry write succeeds (and after any
   skill-write/distribution step already there), read `workflow.agents` (already in memory for
   direct-file sources; add the missing bundle-source import step, mirroring the existing
   `loadBundleWorkflow` call a few lines later in the same file for skill generation, if you haven't
   already loaded the module for a bundle source by this point).
2. For each declared role, dry-run the resolve chain (workflow role → size → default) against the
   fully merged (all three scopes) effective config. "Dry-run" means: call the same resolution logic
   `resolveAgentTargets` uses, but catch/detect the `agent_targets_unavailable` failure instead of
   letting it propagate — you need a "would this resolve or not" boolean, not the actual resolved
   targets.
3. **Only** prompt for roles where the dry-run indicates it would fail — do not prompt for roles
   already covered by an existing size default. This was an explicit choice the user confirmed
   directly (over "always prompt every role every time").
4. For each uncovered role, show its `description` (if the workflow author set one) and `size`, then
   run the pick-existing-or-create-new flow from sub-feature 2, ending in save-confirm with `Save as
   new permanent agent` / `Save as one-off` (same as the "dash row" case in sub-feature 4). Write the
   result into whichever scope this `add` invocation is registering into (confirm at implementation
   time whether this should always match `add`'s own `--scope` answer or be askable independently —
   not yet locked down).

### Decisions already made

- Dry-run-first, only-uncovered-roles prompting — explicitly confirmed by the user over the
  always-prompt alternative.

### LOE

~1 day — mostly wiring into sub-feature 2's shared flow modules; build this after or alongside
sub-feature 4.

---

## Explicitly out of scope / unchanged (do not touch these)

- Provider adapters' argv-building for `model`/`--model`/`-m` — stays a bare opaque string, no
  enumeration added anywhere (confirmed nothing to reuse).
- `WorkflowAgentRole`/`Workflow.agents` authoring-time types
  (`packages/core/src/contracts/agents/agent-role.types.ts`,
  `packages/core/src/authoring/workflow/workflow.types.ts`) — unchanged. This feature only changes
  how `.stepkit/config.json` maps a declared role to a target, never how a workflow author declares
  a role in the first place.
- `stepkit continue`, provider adapter spawn mechanics — untouched.
- `workflow-skill-content.ts`/`workflow-skill-writer.ts` — untouched. (Side note for a future,
  separate piece of work, not this feature: role `description`s are confirmed **not** currently
  surfaced anywhere in generated `SKILL.md` content — a possible follow-up, out of scope here.)
- `stepkit list`, `stepkit run`, `stepkit cancel`, `stepkit skill-check` — unchanged.

## Open questions — do not guess on these, ask a human if you're unsure while implementing

1. Exact non-interactive flag surface for `stepkit agents` — sketched above, not fully designed.
2. Whether `agents` scope-merge is whole-entry-atomic (recommended and shown in 1.6's worked
   example) or something finer-grained — not explicitly confirmed word-for-word by the user.
3. Precise pass-ordering of `validateProviderReferences` vs. the two new ref-checking gates in
   `parse-stepkit-config.ts` — a recommended ordering is given in 1.5, low-risk to adjust.
4. Whether the merge precedence (project-local > project > user) exactly mirrors the `stepkit
   agents` nav display order — the obvious intended reading, implement as such, flag if it turns
   out wrong.

## Verification

- `pnpm typecheck` and `pnpm test` at the repo root must pass after **each** sub-feature lands —
  stage these as separate commits/PRs in the order listed at the top of this document, not as one
  giant change.
- Core schema rewrite (sub-feature 1): the dedicated tests listed in section 1.7 above must all
  pass, plus the full existing test suite (nothing in `agent-execution/`, `known-cli-providers/`,
  or existing CLI command tests should regress).
- `stepkit init`/`stepkit agents` (sub-features 3-4): test the underlying pure logic independent of
  the `@clack/prompts` rendering layer (merge logic, referrer scanning, ref-expansion-for-display
  can all be unit tested with plain data, no terminal involved); for the thin prompt-calling glue
  itself, use the `add-command.test.ts` plain-object-fake pattern shown above, extended to whatever
  new prompt primitives `@clack/prompts` introduces into `StepkitCliPrompts`.
- Manually run `stepkit init` and `stepkit agents` in a scratch project directory (**not** this
  repo — create a throwaway test project) to sanity-check the real terminal UX once built —
  automated tests cannot fully substitute for actually looking at arrow-key menu behavior in a real
  terminal.
