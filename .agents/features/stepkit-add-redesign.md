# Simplify `stepkit add`, add `stepkit remove`, extend `stepkit list`

## Context

`stepkit add` currently forces mandatory `--scope`, `--namespace`, `--name` flags before it can register a workflow (plus optional `--workflow`/`--force`/`--project-skill`/`--user-skill`). Reviewing the command found this is more ceremony than the underlying data justifies: every workflow already carries its own unique `id` (the author sets this via `defineWorkflow({ id: "..." })` in `@stepkit/core`), and namespacing only really earns its keep when avoiding collisions in the shared/global (`user`-scope) registry — day-to-day project registrations rarely need one.

Separately, and independent of this review, a `project-local` scope was added to the codebase today (commit `ca3730c`, 2026-07-22) — a gitignored, personal-to-you-in-this-repo config file (`.stepkit/config-local.json`), distinct from the shared/committed `project` scope (`.stepkit/config.json`). This plan treats that as the current baseline to build on top of, not as something new it introduces.

Two more gaps came up during the review: registered workflows are invisible to `stepkit list` today (it only shows npm-package-discovered workflows, never anything written by `add`), and there's no way to remove a registration once added. Both get built here. `list` additionally groups its output by scope (project-local vs project vs user) so it's obvious at a glance which workflows are personal-to-you on this project, which are shared with the team on this project, and which are yours globally across all projects.

## Background you need before touching code

Skim these existing files fully before writing anything — they're small and the whole feature is built on understanding them correctly:

- `packages/cli/src/internals/commands/add/add-command.ts` — the command being redesigned.
- `packages/cli/src/internals/config/config.ts` — reads/merges `.stepkit/config.json` and `.stepkit/config-local.json`.
- `packages/cli/src/internals/workflow-resolution/workflow-resolution.ts` — resolves a workflow ref (e.g. `stepkit project/review`) at run time, including registry lookups.
- `packages/cli/src/internals/commands/list/list-command.ts` — the command being extended.
- `packages/cli/src/internals/command-registry.ts` — the single dispatch point for all CLI commands.
- `packages/cli/src/command.types.ts` — shared types (`CliCommand`, `CliCommandContext`, `usageText`).
- `packages/core/src/authoring/workflow/workflow.types.ts` — the `Workflow` interface; note it has a required `readonly id: string`.

Key vocabulary, since this plan uses these terms constantly:

- **Scope** — *which config file* a registration lives in. Three values: `"project"` (`<cwd>/.stepkit/config.json`, committed, shared with your team), `"project-local"` (`<cwd>/.stepkit/config-local.json`, gitignored, personal-to-you-in-this-repo), `"user"` (`<homeDir>/.stepkit/config.json`, gitignored, personal-and-global-across-all-your-projects).
- **Namespace** — the first-level key under the `workflows` object in a config file. E.g. in `{"workflows": {"project": {"review": "./review.mjs"}}}`, `"project"` is the namespace and `"review"` is the name.
- **Registry** — the parsed `namespace -> name -> targetRef` structure read out of a config file's `workflows` key.
- **Registered ref** — the string you type to run a registered workflow, e.g. `stepkit project/review`. Format is `<namespace>/<name>`.
- Confusingly, `"project"` is used as BOTH a scope name AND (by convention, and after this change, by default) a namespace name. Keep these mentally separate — a namespace is just a string key in JSON; it has no special meaning to the code except for the two literal strings `"project"` and `"user"`, which the resolver specifically knows how to map back to a config file (see "the reserved-namespace rule" below).

## Part 0 (do this first): fix a pre-existing config-merge bug

**Why this has to happen before anything else:** the whole point of this feature is that `project` and `project-local` scope registrations coexist and are both usable. Right now they can't safely coexist, and you need this fixed before you can even manually test the rest of the plan.

Open `packages/cli/src/internals/config/config.ts` and look at `mergeRawStepKitConfig` (around line 64):

```ts
function mergeRawStepKitConfig(base: unknown, local: unknown): unknown {
  if (!isRecord(base)) {
    return local ?? base;
  }
  if (!isRecord(local)) {
    return base;
  }

  return { ...base, ...local };
}
```

This is called from `loadStepKitProjectConfig` to combine `.stepkit/config.json` (`base`) and `.stepkit/config-local.json` (`local`) into one object before it gets parsed into a registry. The problem: `{ ...base, ...local }` is a **shallow spread**. `workflows` is a single top-level key on both `base` and `local`. If both objects have a `workflows` key, `local.workflows` completely overwrites `base.workflows` — not merged, replaced. So the moment you register anything under `project-local` scope in a repo that already has ANY `project`-scope registrations, all of those `project`-scope registrations become invisible to the resolver (they still exist in the file, they're just never read anymore, because `local`'s `workflows` value is used wholesale instead of `base`'s).

**What to change:** make `workflows` merge one level deeper than everything else, while every *other* top-level key (`workingAgents`, `customAgents`, `interactiveAgents`, `settings`, etc.) keeps the existing shallow "local wins wholesale" behavior — that part is already intentional and has passing tests you must not break.

```ts
function mergeRawStepKitConfig(base: unknown, local: unknown): unknown {
  if (!isRecord(base)) {
    return local ?? base;
  }
  if (!isRecord(local)) {
    return base;
  }

  return {
    ...base,
    ...local,
    workflows: mergeWorkflowsRecord(base.workflows, local.workflows),
  };
}

function mergeWorkflowsRecord(base: unknown, local: unknown): unknown {
  if (!isRecord(base)) {
    return local;
  }
  if (!isRecord(local)) {
    return base;
  }

  const namespaces = new Set([...Object.keys(base), ...Object.keys(local)]);
  const merged: Record<string, unknown> = {};

  for (const namespace of namespaces) {
    const baseBucket = base[namespace];
    const localBucket = local[namespace];

    if (isRecord(baseBucket) && isRecord(localBucket)) {
      merged[namespace] = { ...baseBucket, ...localBucket };
    } else {
      merged[namespace] = localBucket ?? baseBucket;
    }
  }

  return merged;
}
```

Walk through why this is right: if `base.workflows = { project: { reviewA: "./a.mjs" } }` and `local.workflows = { project: { reviewB: "./b.mjs" } }`, the old code would produce `{ project: { reviewB: "./b.mjs" } }` (losing `reviewA`). The new code produces `{ project: { reviewA: "./a.mjs", reviewB: "./b.mjs" } }` — both visible. If they define the *same* name (`reviewA` in both), local's value wins (consistent with the "local overrides shared" precedence already documented for every other key).

**Test to add** in `packages/cli/src/internals/config/workflow-registry-config.test.ts`: write both a `config.json` and a `config-local.json` with `workflows.project` containing different names in each, load via `loadStepKitProjectConfig`, and assert the merged registry contains both. Add a second case where both define the *same* name with different target refs, and assert local's value wins.

## Part 1: shared modules (build these before touching `add`)

You're about to need the same "read a config file, mutate its registry, write it back" logic in three places (`add`, the new `remove`, and `list`/`list --edit`). Build the shared pieces first so `add`'s rewrite can just consume them.

### 1a. `packages/cli/src/internals/workflow-registry/workflow-registry.ts` (new file)

This is a **new directory** (`workflow-registry/`), sibling to the existing `config/`, `workflow-resolution/`, `workflow-skills/` directories — follow their existing convention (one feature-named `.ts` file + a co-located `.test.ts`).

Move these four things out of `add-command.ts` (currently private functions near the bottom of that file, around lines 404-455) into this new file, renaming two of them for clarity:

| Old name (in `add-command.ts`) | New name (in `workflow-registry.ts`) | Behavior change? |
|---|---|---|
| `configPathForScope` | `configPathForScope` | Update the `scope` parameter type to include `"project-local"` — it already does this in the current `add-command.ts`, just move it verbatim. |
| `readConfig` | `readRawStepKitConfigFile` | None — same ENOENT-returns-`{}`, non-object-throws-`CliUsageError` behavior. |
| `writeConfig` | `writeRawStepKitConfigFile` | None — same `mkdir -p` + pretty-printed JSON + trailing newline. |
| `toMutableWorkflowRegistry` | `toMutableWorkflowRegistry` | None — still copies each namespace bucket verbatim (`{ ...entries }`), preserving any non-string sibling keys (agent config) that might live alongside registry entries under the same namespace key. **Do not** replace this with `config.ts`'s `parseWorkflowRegistry` — that function filters to string-valued leaves only and would silently drop agent-config data on the next write. |

Add two new functions:

```ts
export function deleteWorkflowRegistryEntry(
  workflows: Record<string, Record<string, unknown>>,
  namespace: string,
  name: string,
): Record<string, Record<string, unknown>> {
  const bucket = workflows[namespace];
  if (bucket === undefined || !(name in bucket)) {
    return workflows;
  }

  const { [name]: _removed, ...remainingBucket } = bucket;
  const result = { ...workflows };

  if (Object.keys(remainingBucket).length === 0) {
    delete result[namespace];
  } else {
    result[namespace] = remainingBucket;
  }

  return result;
}
```

(Deletes the one entry; removes the whole namespace bucket only if nothing else is left in it — don't touch sibling keys in that bucket, and don't touch other namespaces.)

```ts
export type WorkflowRegistryScope = "project" | "project-local" | "user";

export interface WorkflowRegistryContext {
  readonly cwd: string;
  readonly homeDir?: string;
}

export interface RegisteredWorkflowEntry {
  readonly scope: WorkflowRegistryScope;
  readonly namespace: string;
  readonly name: string;
  readonly targetRef: string;
}

export async function listRegisteredWorkflowEntries(
  context: WorkflowRegistryContext,
): Promise<readonly RegisteredWorkflowEntry[]> {
  const scopes: readonly WorkflowRegistryScope[] = ["project-local", "project", "user"];
  const entries: RegisteredWorkflowEntry[] = [];

  for (const scope of scopes) {
    const path = configPathForScope(scope, context);
    const config = await readRawStepKitConfigFile(path);
    const workflows = toMutableWorkflowRegistry(config.workflows);

    for (const [namespace, bucket] of Object.entries(workflows)) {
      for (const [name, targetRef] of Object.entries(bucket)) {
        if (typeof targetRef === "string") {
          entries.push({ scope, namespace, name, targetRef });
        }
      }
    }
  }

  return entries;
}
```

**Why this reads files raw and separately, instead of reusing `config.ts`'s `loadStepKitProjectConfig`:** two reasons, both important —
1. `loadStepKitProjectConfig` returns the *merged* view (project + project-local combined) — you'd lose the ability to say which file an entry actually came from, which `list`'s grouped headings and `remove`'s disambiguation both need.
2. `loadStepKitProjectConfig` runs the merged config through `@stepkit/core`'s `parseStepKitConfig`, which validates the *entire* agent-config shape (`workingAgents`, etc.) and throws if anything unrelated is malformed. `list` shouldn't crash just because some unrelated agent-config block is malformed — it only cares about the `workflows` key.

`add-command.ts` becomes a thin consumer: delete its private copies of these four functions and `import` them from `workflow-registry.ts` instead.

### 1b. `packages/cli/src/internals/prompts/prompt-helpers.ts` (new file)

Move `promptSelect`, `promptYesNo`, and the `promptText` closure out of `add-command.ts` (currently defined inline inside `resolveInteractiveArgs`, and as standalone functions, around lines 161-214). Give them real signatures instead of closures so `remove` and `list --edit` can call them too:

```ts
import { CliUsageError, type CliCommandContext } from "../command.types.js";

export async function promptText(
  label: string,
  value: string | undefined,
  prompts: CliCommandContext["prompts"],
  usageHint: string,
): Promise<string> {
  if (value !== undefined) {
    return value;
  }
  if (prompts === undefined) {
    throw new CliUsageError(usageHint);
  }
  const answer = (await prompts.text(label)).trim();
  if (!answer) {
    throw new CliUsageError(`${label} is required.`);
  }
  return answer;
}

export async function promptSelect<T extends string>(
  label: string,
  choices: readonly T[],
  prompts: CliCommandContext["prompts"],
  usageHint: string,
): Promise<T> {
  if (prompts === undefined) {
    throw new CliUsageError(usageHint);
  }
  const selected = await prompts.select(label, choices);
  if (!choices.includes(selected as T)) {
    throw new CliUsageError(`Invalid selection for ${label}: ${selected}`);
  }
  return selected as T;
}

export async function promptYesNo(
  label: string,
  prompts: CliCommandContext["prompts"],
  usageHint: string,
): Promise<boolean> {
  return (await promptSelect(label, ["yes", "no"], prompts, usageHint)) === "yes";
}
```

Note the old `promptText` closure baked in an add-specific error message (`` `stepkit add requires --${label.toLowerCase()}...` ``). The extracted version takes `usageHint` explicitly so each call site supplies its own correct message (`add` says "stepkit add requires...", `remove`/`list --edit` say something command-appropriate) — don't hardcode "stepkit add" into a shared helper.

## Part 2: rewrite `add-command.ts`

Read the current file fully first — `packages/cli/src/internals/commands/add/add-command.ts` (currently ~456 lines). You're changing `resolveInteractiveArgs`, adding new validation, and deleting the functions now living in the two new shared modules. `parseArgs` (the flag-parsing function) does **not** need to change — `--scope`/`--namespace`/`--name` are already optional there today; you're only changing what happens when they're *absent*.

### 2a. The scope prompt (always ask, never silently default)

Current code (around line 181):

```ts
scope:
  args.scope ??
  (await promptSelect("Config scope", ["project", "project-local", "user"], prompts)),
```

This already prompts when `--scope` is omitted — good, keep that mechanism. What needs to change is the **label text** shown to the user, so the three choices read clearly instead of as bare scope literals. Since `context.prompts.select(label, choices)` takes the raw string array as the actual returned values (the CLI has no separate "display label vs value" concept today), you have two options:

- **Simplest (recommended):** keep passing the literal scope strings as the choices (`["project-local", "project", "user"]`, reordered to match the intended prompt order), but make the *label* argument (currently `"Config scope"`) descriptive, e.g. `"Where should this workflow be registered? (project-local = just you on this repo, project = shared with your team, user = global across all your projects)"`. Check `packages/cli/src/index.ts`'s `createTerminalPrompts()` to see exactly how `select()` renders `label`/`choices` today (it numbers the choices and prints them) before deciding if this reads well as one line or needs a shorter label with the explanation moved to `usageText` instead.
- **If you want nicer per-choice display text** (e.g. "Project (local, just for you)" as what's shown, but `"project-local"` as what's returned), that requires changing the `StepkitCliPrompts.select` signature in `command.types.ts` to accept `{ value: string; label: string }[]` instead of `readonly string[]`, and updating `createTerminalPrompts()` in `index.ts` plus every test fake that implements `prompts.select`. This is a bigger, cross-cutting change — only do it if the simplest option above genuinely reads badly in the terminal. Flag this choice to a reviewer if you're unsure; don't silently expand scope.

Whichever you pick, the important behavioral point: **there is no default scope value anymore.** If `--scope` is omitted and `context.prompts` is undefined (non-interactive), it must throw `CliUsageError` telling the user to pass `--scope` explicitly — reuse the existing `promptSelect` guard, which already does this.

### 2b. Namespace: default without prompting for `project`/`project-local`, ask-then-maybe-prompt for `user`

Current code always prompts for namespace (around line 184): `namespace: await promptText("Namespace", args.namespace)`. Replace this with scope-dependent logic. This has to run *after* scope is resolved, so restructure `resolveInteractiveArgs` to resolve `scope` first, then branch:

```ts
const scope = args.scope ?? (await promptSelect(/* ... */));

const namespace = await resolveNamespace(args.namespace, scope, prompts);

async function resolveNamespace(
  explicitNamespace: string | undefined,
  scope: "project" | "project-local" | "user",
  prompts: CliCommandContext["prompts"],
): Promise<string> {
  if (explicitNamespace !== undefined) {
    return explicitNamespace;
  }
  if (scope !== "user") {
    return "project";
  }
  if (prompts === undefined) {
    return "user"; // non-interactive default; no prompt possible anyway
  }
  const wantsNamespace = await promptYesNo(
    "Add a namespace to avoid collisions?",
    prompts,
    "stepkit add requires --namespace <namespace> when scope is user and not run interactively.",
  );
  if (!wantsNamespace) {
    return "user";
  }
  return promptText("Namespace", undefined, prompts, "stepkit add requires --namespace <namespace>.");
}
```

Walk through every branch: explicit `--namespace` always wins outright, no prompts, regardless of scope. `project`/`project-local` scope with no explicit namespace → always `"project"`, no prompt at all. `user` scope with no explicit namespace and no prompts available (non-interactive) → defaults to `"user"` rather than throwing, since there's a perfectly good default and no way to ask. `user` scope with prompts available → asks the yes/no, then either prompts for a custom namespace or defaults to `"user"`.

### 2c. Name: derive from `workflow.id`, with reserved-character guards

This is the part that requires reordering the function. Today, `resolveInteractiveArgs` (which resolves namespace/name) runs *before* `validateAndBuildRegistryTarget` (which loads the actual `Workflow` object and knows its `.id`). You need the workflow object loaded *before* you can compute a default name, so restructure `run()`:

```ts
async run(args: AddCommandArgs, context: CliCommandContext): Promise<number> {
  const scope = await resolveScope(args.scope, context.prompts);
  const registryTarget = await validateAndBuildRegistryTarget(
    { ...args, scope }, // validateAndBuildRegistryTarget doesn't actually read namespace/name today, only source/workflow/scope-agnostic bundle logic — check this stays true
    context.cwd,
    context,
  );
  const namespace = await resolveNamespace(args.namespace, scope, context.prompts);
  const name = args.name ?? deriveDefaultWorkflowName(registryTarget.workflow);
  // ...continue with force/skill logic using scope, namespace, name, registryTarget
}
```

Double-check while doing this: does `validateAndBuildRegistryTarget` actually need `namespace`/`name` for anything today? Read its current signature and body (`add-command.ts`, `validateAndBuildRegistryTarget`) — as of this writing it only uses `args.source`, `args.workflow`, and `context.prompts` (for the bundle multi-workflow picker), so this reordering should be safe, but verify before assuming.

The default-name function:

```ts
function deriveDefaultWorkflowName(workflow: WorkflowSkillMetadata | undefined): string {
  const id = workflow?.id;
  if (id === undefined) {
    throw new CliUsageError("stepkit add requires --name <name> for this source.");
  }
  if (/[/#:]/u.test(id)) {
    throw new CliUsageError(
      `Workflow id "${id}" contains a reserved character (/, #, or :) and can't be used as a default registration name. Pass --name <name> explicitly.`,
    );
  }
  if (isDirectWorkflowFileReference(id)) {
    throw new CliUsageError(
      `Workflow id "${id}" looks like a file path and can't be used as a default registration name. Pass --name <name> explicitly.`,
    );
  }
  return id;
}
```

**Why each guard exists** (trace this yourself in `workflow-resolution.ts` if you want to confirm — `resolveWorkflowReferenceInternal` and `resolveRegisteredWorkflowReference`):
- `#` or `:` in the name → when someone later types `stepkit <namespace>/<name>` to run it, `resolveRegisteredWorkflowReference` bails out immediately without even checking the registry (`rawRef.includes(":") || rawRef.includes("#")` short-circuits), and the ref gets misinterpreted as bundle/legacy-package syntax instead, producing a confusing unrelated error. The entry becomes practically unreachable.
- `/` in the name → doesn't outright break (the namespace/name split is on the *first* `/` only, so it technically still parses), but it means the entry can never be run *unqualified*, and invites a different kind of confusion (typos silently resolving to a wrong, unrelated namespace). Guard it anyway for predictability.
- Path-like (`isDirectWorkflowFileReference`) → `resolveWorkflowReferenceInternal` checks "is this a direct file path?" *before* it ever checks the registry, so a name like `./local` would be captured by that branch first and never reach the registry lookup at all.

### 2d. Reserved-namespace-vs-scope guard

Add this validation wherever you finalize `namespace`/`scope` together (right after both are resolved, before writing):

```ts
function assertNamespaceMatchesScope(namespace: string, scope: WorkflowRegistryScope): void {
  if (namespace === "project" && scope === "user") {
    throw new CliUsageError(
      'Namespace "project" is reserved for --scope project or --scope project-local; it would not be resolvable when registered under --scope user.',
    );
  }
  if (namespace === "user" && scope !== "user") {
    throw new CliUsageError(
      'Namespace "user" is reserved for --scope user; it would not be resolvable when registered under this scope.',
    );
  }
}
```

**Why this matters, concretely:** look at `registrySourceForNamespace` in `workflow-resolution.ts` (around line 201). For namespace `"project"`, it *only* ever looks inside the project-merged registry (`config.json` + `config-local.json` combined); for namespace `"user"`, it *only* ever looks inside the user-home registry. If you write an entry with namespace `"project"` into the user-scope file (`~/.stepkit/config.json`), or namespace `"user"` into a project-scope file, the resolver will never find it by its own qualified ref — it's permanently dead JSON. This isn't hypothetical: there's a current test (`add-command.test.ts`, "warns for project skill pointing at user-scoped registration") that exercises exactly `--scope user --namespace project` today and passes, because it only checks the warning text, never whether the entry actually resolves. **You must update that test to expect a thrown `CliUsageError` instead** — its current "passing" behavior is the bug this guard fixes.

### 2e. Widen the duplicate-registration check across both project files

Current code (around line 93) only reads the *one target* scope's config file to check for an existing entry:

```ts
const configPath = configPathForScope(resolvedArgs.scope, context);
const config = await readConfig(configPath);
const workflows = toMutableWorkflowRegistry(config.workflows);
const namespace = workflows[resolvedArgs.namespace] ?? {};

if (!resolvedArgs.force && namespace[resolvedArgs.name] !== undefined) {
  throw new CliUsageError(/* already exists */);
}
```

Because `project` and `project-local` scope both default to namespace `"project"` and get merged together at resolution time (after the Part 0 fix), registering `project/review` under `project-local` when `project`'s own `config.json` *already* has `project.review` would otherwise silently shadow the shared entry the moment the merge happens — with zero warning today. Fix: when `scope` is `"project"` or `"project-local"`, check the *other* project file too before writing:

```ts
async function checkForExistingRegistration(
  scope: WorkflowRegistryScope,
  namespace: string,
  name: string,
  context: CliCommandContext,
): Promise<{ readonly existsInScope: WorkflowRegistryScope } | undefined> {
  const scopesToCheck: readonly WorkflowRegistryScope[] =
    scope === "user" ? ["user"] : ["project", "project-local"];

  for (const candidateScope of scopesToCheck) {
    const path = configPathForScope(candidateScope, context);
    const config = await readRawStepKitConfigFile(path);
    const bucket = toMutableWorkflowRegistry(config.workflows)[namespace];
    if (bucket?.[name] !== undefined) {
      return { existsInScope: candidateScope };
    }
  }

  return undefined;
}
```

Use this instead of the single-file check; if it returns a hit and `!force`, throw `CliUsageError` naming which scope's file already has it (so the user isn't confused about where the conflict lives). This means you now read the target scope's file *twice* in the `project`/`project-local` case (once here, once for the actual write) — that's fine, these are tiny local JSON files; don't over-engineer caching for this.

### 2f. Update the duplicate error message

```ts
throw new CliUsageError(
  `Workflow registration already exists: ${namespace}/${name} (in ${existingScope} config). Use --force to replace it, or --name <name> to register under a different name.`,
);
```

## Part 3: new `stepkit remove <namespace>/<name>` command

New directory `packages/cli/src/internals/commands/remove/`, mirroring the structure of `packages/cli/src/internals/commands/add/`.

### 3a. `remove-command.ts`

```ts
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import {
  configPathForScope,
  deleteWorkflowRegistryEntry,
  readRawStepKitConfigFile,
  toMutableWorkflowRegistry,
  writeRawStepKitConfigFile,
  type WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";
import { workflowSkillName } from "../../workflow-skills/workflow-skill-content.js";
// (skill-directory-exists check: reuse whatever helper workflow-skill-writer.ts
// exposes for locating the skill dir, or a plain fs.stat if none exists yet —
// check that file before writing new path-construction logic here.)

interface RemoveCommandArgs {
  readonly ref: string;
  readonly scope?: WorkflowRegistryScope;
}

export const removeCommand: CliCommand<RemoveCommandArgs> = {
  name: "remove",
  parseArgs(argv: readonly string[]): RemoveCommandArgs {
    if (argv[0] !== "remove") {
      throw new CliUsageError("Expected remove command.");
    }
    const ref = argv[1];
    if (!ref) {
      throw new CliUsageError("stepkit remove requires <namespace>/<name>.");
    }
    // reuse the same flag-parsing shape as add's parseFlags for `--scope`,
    // rejecting any other flag as unknown-for-remove
    const scope = parseScopeFlag(argv.slice(2));
    return { ref, scope };
  },
  async run(args: RemoveCommandArgs, context: CliCommandContext): Promise<number> {
    const parsed = parseNamespaceNameRef(args.ref);
    if (parsed === undefined) {
      throw new CliUsageError(`Invalid workflow ref for stepkit remove: ${args.ref}. Expected <namespace>/<name>.`);
    }

    const candidateScopes: readonly WorkflowRegistryScope[] =
      args.scope !== undefined ? [args.scope] : ["project-local", "project", "user"];

    const matches: WorkflowRegistryScope[] = [];
    for (const scope of candidateScopes) {
      const path = configPathForScope(scope, context);
      const config = await readRawStepKitConfigFile(path);
      const bucket = toMutableWorkflowRegistry(config.workflows)[parsed.namespace];
      if (bucket?.[parsed.name] !== undefined) {
        matches.push(scope);
      }
    }

    if (matches.length === 0) {
      throw new CliUsageError(
        `Workflow registration not found: ${args.ref}. Checked: ${candidateScopes.join(", ")}.`,
      );
    }
    if (matches.length > 1) {
      throw new CliUsageError(
        `Workflow registration ${args.ref} exists in more than one scope (${matches.join(", ")}). Pass --scope to choose which one to remove.`,
      );
    }

    const scope = matches[0];
    const path = configPathForScope(scope, context);
    const config = await readRawStepKitConfigFile(path);
    const workflows = deleteWorkflowRegistryEntry(
      toMutableWorkflowRegistry(config.workflows),
      parsed.namespace,
      parsed.name,
    );
    await writeRawStepKitConfigFile(path, { ...config, workflows });

    context.io.writeLine(`Removed ${args.ref} from ${scope} config.`);

    const skillName = workflowSkillName(parsed.namespace, parsed.name);
    // if a matching skill directory exists on disk, print a one-line notice
    // that it was not cleaned up (check workflow-skill-writer.ts for how add
    // computes the skill directory path so this matches it exactly)

    return 0;
  },
};

function parseNamespaceNameRef(
  ref: string,
): { readonly namespace: string; readonly name: string } | undefined {
  const separatorIndex = ref.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === ref.length - 1) {
    return undefined;
  }
  return { namespace: ref.slice(0, separatorIndex), name: ref.slice(separatorIndex + 1) };
}
```

(`parseNamespaceNameRef` intentionally mirrors `parseRegisteredWorkflowRef` in `workflow-resolution.ts` — same first-`/`-split logic. It's a private, ~5-line function duplicated here rather than importing the one in `workflow-resolution.ts`, since that one isn't exported and this keeps the change isolated to the new file; exporting it instead is a fine alternative if you'd rather not duplicate, your call.)

**Disambiguation behavior to get right:** if the same `namespace/name` exists in more than one candidate scope (very possible for `project`/`project-local` since they default to the same `"project"` namespace), do **not** guess or delete from both — error out and name exactly which scopes matched, telling the user to pass `--scope`. This is the single most important behavioral rule for this command; get it wrong and someone loses data they didn't intend to remove.

### 3b. Register it in `command-registry.ts`

```ts
import { removeCommand } from "./commands/remove/remove-command.js";
// ...
if (argv[0] === "remove") {
  return removeCommand;
}
```

Add this alongside the existing `add`/`continue` branches (which already match on `argv[0]` alone, not `argv.length === 1` — follow that pattern, not `list`'s current stricter one, which you're also fixing below).

## Part 4: extend `stepkit list`

### 4a. Fix the routing bug first

`packages/cli/src/internals/command-registry.ts`, currently:

```ts
if (argv.length === 1 && argv[0] === "list") {
  return listCommand;
}
```

Change to:

```ts
if (argv[0] === "list") {
  return listCommand;
}
```

Without this, `stepkit list --edit` (`argv.length === 2`) falls through to the final `return runCommand;` and gets misinterpreted as an attempt to run a workflow literally named `"list"`. This has to land before `--edit` can work at all — verify it with a quick manual `stepkit list --edit` before writing any of the rename logic, so you're not debugging two problems at once.

### 4b. `parseArgs` accepts `--edit`

```ts
interface ListCommandArgs {
  readonly edit: boolean;
}

parseArgs(argv: readonly string[]): ListCommandArgs {
  if (argv[0] !== "list") {
    throw new CliUsageError("Expected list command.");
  }
  const rest = argv.slice(1);
  if (rest.length === 0) {
    return { edit: false };
  }
  if (rest.length === 1 && rest[0] === "--edit") {
    return { edit: true };
  }
  throw new CliUsageError(`Unknown option for stepkit list: ${rest.join(" ")}`);
}
```

### 4c. Grouped, scope-ordered output (plain `list`, no `--edit`)

```ts
async run(args: ListCommandArgs, context: CliCommandContext): Promise<number> {
  if (args.edit) {
    return runEditFlow(context);
  }

  const registered = await listRegisteredWorkflowEntries({ cwd: context.cwd, homeDir: context.homeDir });
  printScopeGroup(context, "Project (local)", registered.filter((e) => e.scope === "project-local"));
  printScopeGroup(context, "Project (shared)", registered.filter((e) => e.scope === "project"));
  printScopeGroup(context, "User", registered.filter((e) => e.scope === "user"));

  const discovered = await discoverWorkflows({ cwd: context.cwd });
  if (discovered.length > 0) {
    if (registered.length > 0) {
      context.io.writeLine("");
    }
    context.io.writeLine("Discoverable workflow packages:");
    for (const workflow of discovered) {
      context.io.writeLine(`  ${workflow.id}`);
    }
  }

  return 0;
}

function printScopeGroup(
  context: CliCommandContext,
  heading: string,
  entries: readonly RegisteredWorkflowEntry[],
): void {
  if (entries.length === 0) {
    return; // omit empty headings entirely, don't print "Project (local): (none)"
  }
  context.io.writeLine(`${heading}:`);
  for (const entry of entries) {
    context.io.writeLine(`  ${entry.namespace}/${entry.name} -> ${entry.targetRef}`);
  }
}
```

**Important — this changes `list`'s output format**, which the two existing tests in `list-command.test.ts` currently assert exactly (as a bare array of discovered-package id lines, nothing else). Both existing fixtures have no `.stepkit/config.json` present, so `registered` will be empty and those two tests should still pass unchanged once you add the empty-heading guard above — but **verify this by running them**, don't just assume. Then add new tests: one with a `.stepkit/config.json` (and optionally `config-local.json`) present, asserting the grouped headings appear in the right order with the right content.

### 4d. `--edit` interactive rename flow

```ts
async function runEditFlow(context: CliCommandContext): Promise<number> {
  const entries = await listRegisteredWorkflowEntries({ cwd: context.cwd, homeDir: context.homeDir });
  if (entries.length === 0) {
    context.io.writeLine("No registered workflows to edit.");
    return 0;
  }
  if (context.prompts === undefined) {
    throw new CliUsageError("stepkit list --edit requires an interactive session.");
  }

  const labels = entries.map((e) => `${e.scope}: ${e.namespace}/${e.name} -> ${e.targetRef}`);
  const selectedLabel = await promptSelect(
    "Select a workflow to edit",
    labels,
    context.prompts,
    "stepkit list --edit requires an interactive session.",
  );
  const selected = entries[labels.indexOf(selectedLabel)];

  const newNamespace = await promptText(
    "New namespace",
    undefined,
    context.prompts,
    "New namespace is required.",
  );
  const newName = await promptText("New name", undefined, context.prompts, "New name is required.");

  assertValidRegistrationName(newName); // same reserved-char / path-like guard as add
  assertNamespaceMatchesScope(newNamespace, selected.scope); // same guard as add

  const collisionScope = await findExistingRegistrationScope(newNamespace, newName, selected.scope, context);
  const isRenamingInPlace =
    collisionScope !== undefined && newNamespace === selected.namespace && newName === selected.name;

  if (collisionScope !== undefined && !isRenamingInPlace) {
    const overwrite = await promptYesNo(
      `${newNamespace}/${newName} already exists in ${collisionScope} config. Overwrite?`,
      context.prompts,
      "Confirmation required.",
    );
    if (!overwrite) {
      context.io.writeLine("Cancelled.");
      return 0;
    }
  }

  const path = configPathForScope(selected.scope, context);
  const config = await readRawStepKitConfigFile(path);
  let workflows = toMutableWorkflowRegistry(config.workflows);
  workflows = deleteWorkflowRegistryEntry(workflows, selected.namespace, selected.name);
  workflows[newNamespace] = { ...workflows[newNamespace], [newName]: selected.targetRef };
  await writeRawStepKitConfigFile(path, { ...config, workflows });

  context.io.writeLine(
    `Renamed ${selected.scope}: ${selected.namespace}/${selected.name} -> ${newNamespace}/${newName}`,
  );
  // same non-blocking skill-directory notice as remove, keyed on the OLD name
  return 0;
}
```

`findExistingRegistrationScope` is the same widened cross-file check as `add`'s (Part 2e) — for `project`/`project-local` scope, check both project files; for `user` scope, check just that file. Reuse the same function if you can share it cleanly between `add-command.ts` and `list-command.ts` (candidate for a third shared helper in `workflow-registry.ts` if the signature generalizes nicely — your call whether it's worth the extra abstraction versus two small near-duplicate implementations; don't force it if the call sites end up awkward).

**Scope stays fixed during rename** — only namespace/name change, never which file the entry lives in. This is a deliberate v1 simplification (no cross-scope move), noted in the non-goals below.

## Files touched, summarized

**New:**
- `packages/cli/src/internals/workflow-registry/workflow-registry.ts` + `.test.ts`
- `packages/cli/src/internals/prompts/prompt-helpers.ts` + `.test.ts`
- `packages/cli/src/internals/commands/remove/remove-command.ts` + `.test.ts`

**Modified:**
- `packages/cli/src/internals/config/config.ts` — Part 0 merge fix + new test.
- `packages/cli/src/internals/commands/add/add-command.ts` — Parts 2a-2f.
- `packages/cli/src/internals/commands/list/list-command.ts` — Part 4.
- `packages/cli/src/internals/command-registry.ts` — routing fix + `remove` registration.
- `packages/cli/src/command.types.ts` — `usageText` update (simplified `add` line, new `remove` line, `list [--edit]` line).
- `packages/cli/src/internals/commands/add/add-command.test.ts` — see "tests that must change" below.
- `packages/cli/src/internals/commands/list/list-command.test.ts` — new grouped-output and `--edit` tests.
- `packages/cli/README.md` — simplify `add` example; document the scope prompt and grouped `list` output.
- `.pi/rules/packages/cli/cli.md`, `.pi/rules/packages/cli/src/internals/commands/commands.md`, `.pi/rules/packages/cli/src/internals/commands/list/list.md`, `.pi/rules/packages/cli/src/internals/internals.md` — prose sync (new optional flags, `remove` command, grouped `list`, new `workflow-registry/`/`prompts/` subdirectories).

## Tests that must change (not just "add more")

Read `add-command.test.ts` in full before touching it — don't guess at what it currently asserts. At minimum:
- Any test asserting `prompts.text`/`prompts.select` is called for `"Namespace"`/`"Workflow name"` on a flags-light run needs its expectations rewritten — those prompts mostly disappear now.
- The `--scope user --namespace project` test ("warns for project skill pointing at user-scoped registration") must flip to asserting a thrown `CliUsageError`, per Part 2d.
- Add: a zero-flag happy path asserting the scope prompt fires, namespace/name do not, and the final registration lands at `project/<workflow.id>`.
- Add: `--name` explicit override skips derivation entirely.
- Add: a workflow whose `id` contains `/`, `#`, `:`, or looks like a path, with no `--name` given, throws the reserved-character error.
- Add: the widened duplicate check catches a `project`-scope entry when registering the same `namespace/name` under `project-local`, and vice versa.

## Non-goals (explicit — keep this pass scoped)

- No skill-file/distribution cleanup on `remove` or rename — one-line notice only, no automatic deletion.
- No cross-scope move in `list --edit` (namespace/name can change, scope cannot, in this pass).
- Not fixing the separate, pre-existing risk that a *custom* namespace reused independently at both a project-family scope and `user` scope can mask entries (first-registry-object-wins for qualified lookups where a namespace exists in more than one unrelated place) — worth a one-line README caveat, not a code fix here.

## Verification

1. `pnpm --filter @stepkit/cli test` — full CLI suite; every test change listed above must land first or this will fail.
2. Manual smoke test from a scratch directory (do this yourself, step by step, before calling the feature done):
   - `stepkit add ./some-workflow.mjs` with zero other flags → should prompt scope only, nothing else → pick "project" → confirm it registers to `project/<workflow.id>` by reading the resulting `.stepkit/config.json`.
   - `stepkit add ./some-workflow.mjs --scope project-local` → registers into `.stepkit/config-local.json` under the same `project` namespace. Run `stepkit list` and confirm it appears under "Project (local)" while the earlier one still shows under "Project (shared)".
   - Run `stepkit project/<workflow.id>` and confirm it actually executes (proves the Part 0 merge fix worked — both entries resolve).
   - `stepkit remove project/<workflow.id>` with no `--scope`, while it exists in both files → should error asking you to pass `--scope`. Retry with `--scope project-local` → should remove only that copy; `stepkit list` should no longer show it under "Project (local)" but should still show the shared copy under "Project (shared)".
3. `pnpm lint` / `pnpm typecheck` for the whole repo (you're touching shared CLI internals imported from multiple commands).
4. `node scripts/verify-repository-docs.mjs` once the `.pi/rules`/README updates are in.

## After this plan is approved

Per the request that led to this document: once approved, write this plan's content (expanded as needed) to `.agents/features/stepkit-add-redesign.md` in the repo as the reference spec for implementation, rather than leaving it only in the ephemeral plan-mode file.
