# `stepkit doctor` + `stepkit update`

Status: design complete, no implementation started. This document assumes **zero prior context** —
you have not read the conversation that produced it, and you may be new to this codebase. Every
term, every current file, and every target shape is spelled out in full below, with verbatim code
quoted from the real files as they exist today. Read the Glossary first if any term is unfamiliar,
then "Why this exists," then work sub-feature by sub-feature **in the listed order** — later ones
depend on earlier ones existing.

## Glossary (read this first if any term below is unfamiliar)

- **Workflow**: a TypeScript object shaped like `{ id, inputShape, start, ... }`, authored with
  `@stepkit/sdk`'s `defineWorkflow(...)` (or hand-built against `@stepkit/core`'s lower-level
  primitives). Each workflow has a unique `id` string.
- **Discovered workflow**: a workflow found automatically because it's exported from an npm package
  in the consumer's own `package.json` dependencies, and that package's `package.json` has
  `"keywords": ["stepkit-workflow"]`. No registration step needed — `stepkit list`/`stepkit
  <workflow-id>` finds it by scanning `node_modules`.
- **Registered workflow**: a workflow made runnable by a short `<namespace>/<name>` reference via
  `stepkit add`, which writes an entry into a `.stepkit/config.json`-family file's `workflows` key.
  Unlike discovered workflows, a registered workflow's *source* can be one of three different kinds
  (see next three terms) — this distinction is the crux of this whole feature.
- **Direct-file registered workflow**: a registered entry whose source is a literal file path in the
  consumer's own repo (e.g. `stepkit add ./workflows/review.mjs`). This file has **no npm version at
  all** — it's just source code sitting in the consumer's own git repo, always exactly as current as
  whatever the consumer last edited. There is nothing to "update."
- **Bundle-package registered workflow**: a registered entry whose source is an npm package
  containing potentially *multiple* workflows, addressed as `<package-name>#<workflow-name>` (e.g.
  `@acme/workflows#release`). The package has a `package.json` with a `stepkit.workflows` map: `{
  "release": "./dist/release.js#releaseWorkflow" }` (relative module path + export name). **The whole
  package is one version** — if the package bumps from 1.0.0 to 2.0.0, *every* workflow it contains
  moves to that version together, whether or not the consumer asked to update all of them.
- **Plain-package registered workflow**: a registered entry whose source is just an npm package name
  with no `#workflow-name` suffix — the package exports exactly one workflow directly (no bundle
  manifest). Has a real npm version, just like a bundle package, but contains only one workflow.
- **Scope**: which of three files a workflow registration (or agent config) lives in — **project**
  (`.stepkit/config.json`, committed to git, shared with the team), **project-local**
  (`.stepkit/config-local.json`, gitignored, personal-to-you-in-this-repo), or **user**
  (`~/.stepkit/config.json`, this person's home directory, applies across all their projects).
- **Deprecation manifest**: a new, currently-nonexistent data structure this feature introduces —
  a list of "this exported symbol from `@stepkit/core`/`@stepkit/sdk` became deprecated as of version
  X, and will stop working as of version Y" entries, shipped inside `@stepkit/core` itself.
- **Deprecated (warning tier)**: a manifest entry says a symbol is deprecated as of some version, but
  gives no removal version — using it still works, `stepkit doctor` just prints a heads-up.
- **Removed (blocking tier)**: a manifest entry additionally says the symbol is *removed* as of some
  version — a workflow using it will actually break once that version is installed. `stepkit doctor`
  treats this as a hard problem, and `stepkit update` blocks on it by default.
- **Doctor scan** / **the scanner**: the new static-analysis code that reads a workflow's *source
  text* (not a running import) and looks for `import { symbolName } from "@stepkit/core"`-style
  lines, checking each named symbol against the deprecation manifest.

## Why this exists

Once `@stepkit/core`/`@stepkit/sdk`/`@stepkit/cli` are published to npm and real consumers depend on
them, there's currently **no way to safely bump those dependencies** (or a registered bundle-package
workflow's version) without risking silent breakage — if the authoring API changed underneath an old
workflow, the consumer finds out only when the workflow fails at runtime, possibly with a confusing
error unrelated to the real cause.

This feature adds two new CLI commands to close that gap:

- **`stepkit doctor`** — scans every workflow the consumer has (both discovered and registered) for
  usage of deprecated/removed `@stepkit/core`/`@stepkit/sdk` symbols. Works standalone (e.g. in CI,
  or just to check status any time), returns a nonzero exit code when it finds something, so it can
  gate a build.
- **`stepkit update`** — bumps `@stepkit/core`/`@stepkit/sdk`/`@stepkit/cli` themselves (`--all` or
  bare `stepkit update`) and/or registered bundle/plain-package workflow sources (`--workflows` /
  `--workflow=<name>`). **Always runs the doctor scan first**, before writing anything: warns on
  deprecated-but-still-working usage, hard-blocks on usage of a symbol that will actually be removed
  at the version being updated *to* (override with `--force`).

### Decisions already made — do not relitigate these

These were explicitly decided with the project owner during planning. Don't second-guess them while
implementing; if one turns out to be wrong once you're deep in the code, flag it, don't silently
change it.

1. **The scanner is regex/text-based import matching, not full TypeScript type-checking.** It reads
   raw source text and pattern-matches `import { ... } from "@stepkit/core"`-style statements. This is
   far cheaper to build than a real type-checker, but it has known, *accepted* blind spots (spelled
   out in Sub-feature 2 below) — don't try to "fix" these blind spots as part of this work; they're a
   deliberate scope cut, not a bug.
2. **`doctor` ships as its own standalone command**, not merely something baked invisibly into
   `update`. `update` calls the exact same underlying scan function as a pre-flight step.
3. **The deprecation manifest ships empty.** There is zero deprecation precedent anywhere in this
   codebase today (confirmed — no `@deprecated` JSDoc anywhere in `packages/core`/`packages/sdk`, no
   `CHANGELOG.md` in any package, no `.changeset/*.md` files). You are building the *schema* and the
   *scanning machinery*, with a genuinely empty `deprecationManifest: []`. Do not invent fake/seed
   entries "to prove it works" — write tests that inject fake entries via a test-only override
   instead (see Sub-feature 3 and 4's test sections).
4. **Locally-added direct-file workflow sources need no update handling.** They have no version;
   `update` must detect this source kind and report it as skipped, never silently ignore it and never
   try to act on it.
5. **Plain npm `stepkit-workflow`-keyword dependencies (discovered workflows) are out of scope for
   `update`'s special logic.** They're ordinary entries in the consumer's own `package.json`
   dependencies — they ride the consumer's normal `npm update`/`pnpm update`/etc. on their whole
   project. `stepkit update --workflows` only ever acts on **registered** bundle/plain-package
   sources (i.e. things that went through `stepkit add`), never on `discoverWorkflows()`'s output.

### Order of work — do these in this order, later ones depend on earlier ones

0. Add `peerDependencies` between `@stepkit/core`/`@stepkit/sdk`/`@stepkit/cli` (prerequisite —
   `update`'s self-bump logic has nothing to check version compatibility against without this).
1. Core deprecation manifest schema + scaffolding, in `@stepkit/core`.
2. CLI regex scanner + shared scan-target resolution (needs #1's types), plus a small refactor to
   consolidate duplicated bundle-manifest-reading code that already exists in two places.
3. `stepkit doctor` command (needs #1 and #2).
4. `stepkit update` command (needs #1, #2, and #3's scan function).

---

## Full current-state reference (read carefully before touching anything)

### Current package versions and dependencies (verified by reading the actual files)

`packages/core/package.json` — version `0.0.0`, dependency `ajv ^8.17.1` only. No dependency on
`@stepkit/sdk` or `@stepkit/cli` (core is the foundation; nothing depends *on* it internally except
sdk and cli).

`packages/sdk/package.json` — version `0.0.0`, dependency `"@stepkit/core": "workspace:*"`. No
`peerDependencies` key exists today.

`packages/cli/package.json` — version `0.0.0`, dependencies `"@stepkit/core": "workspace:*"` and
`"skills": "^1.5.19"` (an unrelated third-party package used for skill distribution, not
`@stepkit/sdk` — **cli does not depend on sdk at all**, today or in this plan). No
`peerDependencies` key exists today.

All three are pre-release, unpublished (`0.0.0`). `.changeset/config.json` has
`"updateInternalDependencies": "patch"`, and empty `"fixed": []` / `"linked": []` arrays — meaning
core/sdk/cli are **not** configured to version in lockstep today; they can drift apart over releases.
This is exactly why Sub-feature 0 (peerDependencies) matters: without it, there is no machine-readable
statement anywhere of "this sdk version needs at least this core version."

### Current `@stepkit/core` public exports

File: `packages/core/src/index.ts` (reproduced in full, 89 lines):

```ts
export { parseStepKitConfig } from "./agent-targeting/parse-stepkit-config/parse-stepkit-config.js";
export { resolveAgentTargets } from "./agent-targeting/resolve-agent-targets/resolve-agent-targets.js";
export type {
  ResolveAgentTargetsOptions,
  StepKitAgentMode,
  StepKitAgentTarget,
  StepKitConfig,
  StepKitCustomAgentConfig,
  StepKitRoleAgentMappings,
  StepKitSizeAgentMappings,
  StepKitWorkflowConfig,
} from "./agent-targeting/targeting.types.js";
export {
  done,
  fail,
  isDoneNode,
  isFailNode,
  isStepNode,
  type JsonSchemaObject,
  jsonSchema,
  normalizeShape,
  promptTemplate,
  shape,
  step,
} from "./authoring/authoring.js";
export type {
  ContinuationResult,
  ContinuationStepConfig,
  DoneNode,
  FailNode,
  PromptTemplateSource,
  StepConfig,
  StepContinuation,
  StepErrorContinuation,
  StepFactory,
  StepNode,
} from "./authoring/step/continuation.types.js";
export type { Workflow } from "./authoring/workflow/workflow.types.js";
export type {
  AgentAdapter,
  AgentAdapterObject,
  AgentAdapterRequest,
  AgentAdapterSelection,
  AgentMessage,
  AgentPrompt,
  AgentTool,
} from "./contracts/agents/agent-adapter.types.js";
export type {
  AgentModelTarget,
  WorkflowAgentRole,
  WorkflowAgentSize,
  WorkflowAgentThinking,
} from "./contracts/agents/agent-role.types.js";
export type { Failure } from "./contracts/failures/failure.js";
export type { RunContext, RunContextState } from "./contracts/run-context/run-context.types.js";
export type {
  PlainObject,
  Schema,
  ShapeInput,
  ShapeObject,
  ShapePrimitive,
} from "./contracts/shapes/shape.types.js";
export {
  type ProviderRegistryKey,
  providerRegistry,
} from "./known-cli-providers/registry/provider-registry.js";
export type {
  ProviderAdapter,
  ProviderInteractiveRequest,
  ProviderWorkingProcessRequest,
  ProviderWorkingProcessResult,
  ProviderWorkingRequest,
  ProviderWorkingRunner,
} from "./known-cli-providers/registry/provider-registry.types.js";
export { readRunEvents, readRunState, writeRunState } from "./runtime/artifacts/run-storage.js";
export { createRunContext } from "./runtime/run-context/create-run-context.js";
export { runWorkflow } from "./runtime/run-workflow/run-workflow.js";
export type {
  Event,
  InteractiveProcessRequest,
  InteractiveProcessResult,
  InteractiveProcessRunner,
  Result,
  RunWorkflowOptions,
  WorkingAgentProcessRequest,
  WorkingAgentProcessResult,
  WorkingAgentProcessRunner,
} from "./runtime/run-workflow/run-workflow.types.js";
```

The **value** exports (things a workflow author can actually `import { x } from "@stepkit/core"` and
call/use at runtime — these are the only ones that can ever appear in the deprecation manifest, since
type-only exports leave no import trace at the value level a regex scan could catch, and more
importantly can't "stop working," only stop type-checking): `parseStepKitConfig`,
`resolveAgentTargets`, `done`, `fail`, `isDoneNode`, `isFailNode`, `isStepNode`, `jsonSchema`,
`normalizeShape`, `promptTemplate`, `shape`, `step`, `providerRegistry`, `readRunEvents`,
`readRunState`, `writeRunState`, `createRunContext`, `runWorkflow`.

`packages/core/src` top-level directories: `agent-execution/`, `agent-targeting/`, `authoring/`,
`contracts/`, `known-cli-providers/`, `runtime/` (plus `index.ts`/`index.test.ts` at the root). A new
`deprecations/` directory sits as a new sibling to these, at the same top level.

### Current `@stepkit/sdk` public exports

File: `packages/sdk/src/index.ts` (reproduced in full, 19 lines):

```ts
export type {
  FailNode,
  PromptTemplateSource,
  RunContext,
  RunContextState,
  Schema,
  ShapeInput,
  ShapeObject,
  ShapePrimitive,
  StepConfig,
  StepFactory,
  Workflow,
} from "@stepkit/core";
export { done, fail, jsonSchema, promptTemplate, shape, step } from "@stepkit/core";
export { defineWorkflow } from "./workflow-builder/workflow-builder.js";
export type {
  DefinedWorkflow,
  WorkflowBuilderOptions,
} from "./workflow-builder/workflow-builder.types.js";
```

Note `sdk` re-exports a *subset* of core's value exports (`done`, `fail`, `jsonSchema`,
`promptTemplate`, `shape`, `step` — not `parseStepKitConfig`, `resolveAgentTargets`,
`providerRegistry`, `readRunEvents`, `readRunState`, `writeRunState`, `createRunContext`,
`runWorkflow`, which are core-internal/CLI-facing, not authoring-facing) plus its own
`defineWorkflow`. **This means a manifest entry for, say, `step` must be checked against imports from
*either* `"@stepkit/core"` or `"@stepkit/sdk"`** — a workflow author might import it from whichever
package they installed directly. The manifest schema (Sub-feature 1) models this by tagging each
entry with which package(s) it applies to.

### The CLI command contract every command implements

File: `packages/cli/src/internals/command.types.ts` (reproduced in full, 61 lines):

```ts
import type { Event, InteractiveProcessRunner, WorkingAgentProcessRunner } from "@stepkit/core";

import type { SkillsCliProcessRunner, SkillsCliResolver } from "./workflow-skills/skills-cli.js";

export const usageText = [
  "Usage:",
  "  stepkit add <workflow-file-or-bundle> --scope <project|project-local|user> --namespace <namespace> --name <name> [--workflow <workflow>] [--project-skill] [--user-skill] [--force]",
  "  stepkit list",
  "  stepkit continue --session-file <path>",
  "  stepkit continue --json-file <path>",
  "  stepkit continue --json '<json>'",
  "  stepkit cancel [--reason '<text>']",
  "  stepkit <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]",
  "  stepkit <workflow-ref> <workflowRunName> --resume",
  "",
  "Workflow refs:",
  "  ./workflow.mjs                    direct local workflow file",
  "  project/review                    registered project workflow",
  "  user/cleanup                      registered user workflow",
  "  @acme/workflows#release           bundle manifest workflow",
  "  @acme/workflows:releaseWorkflow   legacy package export compatibility",
].join("\n");

export class CliUsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${usageText}`);
    this.name = "CliUsageError";
  }
}

export interface StepkitCliIo {
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

export interface StepkitCliPrompts {
  text: (prompt: string) => Promise<string>;
  select: (prompt: string, choices: readonly string[]) => Promise<string>;
}

export interface CliCommandContext {
  cwd: string;
  homeDir?: string;
  io: StepkitCliIo;
  prompts?: StepkitCliPrompts;
  eventSink?: (event: Event) => void | Promise<void>;
  env?: Record<string, string | undefined>;
  processRunner?: InteractiveProcessRunner;
  workingAgentProcessRunner?: WorkingAgentProcessRunner;
  skillsCliResolver?: SkillsCliResolver;
  skillsCliProcessRunner?: SkillsCliProcessRunner;
  runNameClock?: () => Date;
  runNameRandomSuffix?: () => string;
}

export interface CliCommand<TArgs> {
  name: string;
  parseArgs(argv: readonly string[]): TArgs;
  run(args: TArgs, context: CliCommandContext): Promise<number>;
}
```

Every command is `{ name, parseArgs, run }`. `parseArgs` throws `CliUsageError` on bad input. `run`
returns a plain number exit code. You'll add two new optional fields to `CliCommandContext` (Sub-feature
4) — note the existing `skillsCliResolver`/`skillsCliProcessRunner` pair is the **exact precedent
pattern** to copy: an injectable async resolver plus an injectable process-spawning function, both
optional, both defaulting to a real implementation when undefined. See "The injectable
resolver/runner seam" below for the full existing example.

### Command registration — the one file that dispatches every command

File: `packages/cli/src/internals/command-registry.ts` (reproduced in full):

```ts
import type { CliCommand } from "./command.types.js";
import { addCommand } from "./commands/add/add-command.js";
import { continueCommand } from "./commands/continue/continue-command.js";
import { listCommand } from "./commands/list/list-command.js";
import { runCommand } from "./commands/run/run-command.js";
import { skillCheckCommand } from "./commands/skill-check/skill-check-command.js";

/**
 * Resolves the CLI command implementation for a given argv.
 *
 * This is the only file that needs to change to register a new command.
 */
export function resolveCommand(argv: readonly string[]): CliCommand<unknown> {
  if (argv[0] === "add") {
    return addCommand;
  }

  if (argv.length === 1 && argv[0] === "list") {
    return listCommand;
  }

  if (argv.length === 1 && argv[0] === "skill-check") {
    return skillCheckCommand;
  }

  if (argv[0] === "continue") {
    return continueCommand;
  }

  return runCommand;
}
```

You will add two more `if` branches here — `doctor` and `update` — before the final
`return runCommand;` fallthrough (which otherwise interprets `argv[0]` as a workflow reference to
run). Match the `argv[0] === "add"`/`"continue"` style (matches on `argv[0]` alone, allowing
trailing flags), not `list`/`skill-check`'s stricter `argv.length === 1` style, since both new
commands take flags.

### The simplest existing command — model for `doctor`'s shape

File: `packages/cli/src/internals/commands/skill-check/skill-check-command.ts` (reproduced in full,
25 lines) — this is the closest existing analog to "scan workflows, print findings":

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
  async run(_args: Record<string, never>, context: CliCommandContext): Promise<number> {
    const workflows = await discoverWorkflows({ cwd: context.cwd });
    const reports = await findPackagesMissingSkills(workflows);

    for (const report of reports) {
      context.io.writeLine(
        `Missing SKILL.md for ${report.packageName}: ${report.workflowIds.join(", ")}`,
      );
    }

    return 0;
  },
};
```

**Important divergence you must make deliberately**: this command always `return 0`, even when it
found things to report — it's purely advisory, not a gate. `doctor` needs to be a real gate (nonzero
exit when it finds blocking problems), so do **not** copy the "always return 0" part. Everything else
about this file's shape (bare object literal, `parseArgs` validates argv strictly then returns a
fixed-shape args object, `run` iterates found items and calls `context.io.writeLine` once per item) is
exactly the pattern to follow.

### `discoverWorkflows` — node_modules auto-discovery (do not touch its behavior, only add one export)

File: `packages/cli/src/internals/discovery/discovery.ts` (reproduced in full, 129 lines):

```ts
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Workflow } from "@stepkit/core";

import { isWorkflow } from "../workflow-resolution/workflow-validator.js";

type PackageJson = {
  name?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  keywords?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export interface DiscoveredWorkflow {
  readonly id: string;
  readonly packageName: string;
  readonly packageDir: string;
  readonly exportName: string;
  readonly workflow: Workflow;
}

export interface DiscoverWorkflowsOptions {
  readonly cwd?: string;
}

export async function discoverWorkflows(
  options: DiscoverWorkflowsOptions = {},
): Promise<DiscoveredWorkflow[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const consumerPackageJson = await readPackageJson(join(cwd, "package.json"));
  const dependencyNames = Object.keys({
    ...consumerPackageJson.dependencies,
    ...consumerPackageJson.devDependencies,
  }).sort();
  const discovered: DiscoveredWorkflow[] = [];

  for (const dependencyName of dependencyNames) {
    const packageJsonPath = resolvePackageJson(dependencyName, cwd);
    if (!packageJsonPath) {
      continue;
    }

    const packageJson = await readPackageJson(packageJsonPath);
    if (!isWorkflowPackage(packageJson)) {
      continue;
    }

    const packageName = packageJson.name ?? dependencyName;
    const packageDir = dirname(packageJsonPath);
    const packageModule = await importPackage(packageJsonPath, packageJson);

    for (const [exportName, exportedValue] of Object.entries(packageModule)) {
      if (exportName === "default" || !isWorkflow(exportedValue)) {
        continue;
      }

      discovered.push({
        id: `${packageName}:${exportName}`,
        packageName,
        packageDir,
        exportName,
        workflow: exportedValue,
      });
    }
  }

  return discovered;
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJson;
}

function resolvePackageJson(packageName: string, cwd: string): string | undefined {
  const requireFromCwd = createRequire(join(cwd, "package.json"));

  try {
    return requireFromCwd.resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

function isWorkflowPackage(packageJson: PackageJson): boolean {
  return Array.isArray(packageJson.keywords) && packageJson.keywords.includes("stepkit-workflow");
}

async function importPackage(
  packageJsonPath: string,
  packageJson: PackageJson,
): Promise<Record<string, unknown>> {
  const packageRoot = dirname(packageJsonPath);
  const entryPoint = getImportEntryPoint(packageJson);
  const entryPath = join(packageRoot, entryPoint);

  return import(pathToFileURL(entryPath).href) as Promise<Record<string, unknown>>;
}

function getImportEntryPoint(packageJson: PackageJson): string {
  if (typeof packageJson.exports === "string") {
    return packageJson.exports;
  }

  if (isPlainObject(packageJson.exports)) {
    const rootExport = packageJson.exports["."];
    if (typeof rootExport === "string") {
      return rootExport;
    }
    if (isPlainObject(rootExport)) {
      const importExport = rootExport.import;
      if (typeof importExport === "string") {
        return importExport;
      }
    }
  }

  return packageJson.module ?? packageJson.main ?? "./index.js";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

**The one change needed here** (Sub-feature 2): the scanner needs the *file path* of a discovered
package's entry point (to read its source text), but `importPackage`'s `entryPath` computation is
currently a private local variable, thrown away after the dynamic `import()` call. Export a small
helper so the scanner doesn't have to reimplement `getImportEntryPoint`'s resolution rules:

```ts
export function resolvePackageEntryFilePath(packageJson: PackageJson, packageDir: string): string {
  return join(packageDir, getImportEntryPoint(packageJson));
}
```

Then have `importPackage` call this new function internally instead of duplicating the `join(...)`
line, so there's exactly one implementation. This is the **only** change to this file — everything
else about discovery's behavior is unchanged.

### The config-registry reader — validated, merged, read-only

File: `packages/cli/src/internals/config/config.ts` (reproduced in full, 206 lines):

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseStepKitConfig, type StepKitConfig } from "@stepkit/core";

export class CliConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliConfigError";
  }
}

export interface StepKitProjectConfig {
  readonly stepkitConfig: StepKitConfig | undefined;
  readonly workflowRegistry: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * Loads optional project configuration for workflow runs.
 *
 * A missing `.stepkit/config.json` is allowed so code-only workflows and commands that do not
 * need agent configuration can still run; core reports a workflow failure if a later agent step
 * requires configuration that was not provided.
 */
export async function loadStepKitConfig(cwd = process.cwd()): Promise<StepKitConfig | undefined> {
  return (await loadStepKitProjectConfig(cwd)).stepkitConfig;
}

export async function loadStepKitProjectConfig(cwd = process.cwd()): Promise<StepKitProjectConfig> {
  const [base, local] = await Promise.all([
    readRawStepKitConfig(join(cwd, ".stepkit", "config.json"), {
      description: ".stepkit/config.json",
    }),
    readRawStepKitConfig(join(cwd, ".stepkit", "config-local.json"), {
      description: ".stepkit/config-local.json",
    }),
  ]);

  if (base === undefined && local === undefined) {
    return { stepkitConfig: undefined, workflowRegistry: {} };
  }

  const merged = mergeRawStepKitConfig(base, local);

  try {
    return {
      stepkitConfig: parseStepKitConfig(toCoreStepKitConfigValue(merged)),
      workflowRegistry: parseWorkflowRegistry(merged),
    };
  } catch (error) {
    const detail = formatConfigValidationDetail(error);
    throw new CliConfigError(`Invalid .stepkit/config.json.${detail}`, { cause: error });
  }
}

function mergeRawStepKitConfig(base: unknown, local: unknown): unknown {
  if (!isRecord(base)) {
    return local ?? base;
  }
  if (!isRecord(local)) {
    return base;
  }

  return { ...base, ...local };
}

export async function loadStepKitUserWorkflowRegistry(
  homeDir = homedir(),
): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> {
  const parsed = await readRawStepKitConfig(join(homeDir, ".stepkit", "config.json"), {
    description: "~/.stepkit/config.json",
  });

  return parsed === undefined ? {} : parseWorkflowRegistry(parsed);
}

// ...readRawStepKitConfig / parseWorkflowRegistry / toCoreStepKitConfigValue / error-formatting
// helpers omitted here for length — read the file directly if you need them; nothing below this
// point in the file needs to change for this feature.
```

Two functions matter for this feature: `loadStepKitProjectConfig(cwd)` → `{ stepkitConfig,
workflowRegistry }` where `workflowRegistry: Record<namespace, Record<name, targetRefString>>` is
the **merged** (project + project-local) view, and `loadStepKitUserWorkflowRegistry(homeDir)` → the
same shape for user scope. **Use these to enumerate registered workflows** — do not write a second,
raw, unvalidated config reader; `add-command.ts` already made that mistake once (see next section),
don't repeat it for new code.

### `add-command.ts` — how entries get into the registry, and the bundle-manifest logic duplication you're consolidating

File: `packages/cli/src/internals/commands/add/add-command.ts` (key excerpts — read the full file
before editing, it's ~290 lines):

```ts
async function validateAndBuildRegistryTarget(
  args: ResolvedAddCommandArgs,
  cwd: string,
  context: CliCommandContext,
): Promise<string> {
  if (await isBundleSource(args.source, cwd)) {
    const workflowNames = await readBundleWorkflowNames(args.source, cwd);
    // ... picks one workflow name, returns `${args.source}#${workflowName}`
  }
  // ... else validates as a direct file, returns args.source unchanged
}

async function isBundleSource(source: string, cwd: string): Promise<boolean> {
  if (!isDirectWorkflowFileReference(source)) {
    return true;
  }
  try {
    return (await stat(resolve(cwd, source))).isDirectory();
  } catch {
    return false;
  }
}

async function readBundleWorkflowNames(source: string, cwd: string): Promise<string[]> {
  const packageJsonPath = resolveBundlePackageJsonPath(source, cwd);
  const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  // ... validates parsed.stepkit.workflows is a Record<string, string>, returns Object.keys(...)
}

function resolveBundlePackageJsonPath(source: string, cwd: string): string {
  if (isDirectWorkflowFileReference(source)) {
    return resolve(cwd, source, "package.json");
  }
  return createRequire(resolve(cwd, "package.json")).resolve(`${source}/package.json`);
}

function configPathForScope(scope: ResolvedAddCommandArgs["scope"], context: CliCommandContext): string {
  const baseDir = scope === "project" ? context.cwd : (context.homeDir ?? homedir());
  return join(baseDir, ".stepkit", "config.json");
}
```

**Critical fact you must understand before writing the scanner**: this bundle-manifest-reading logic
(read a package's `package.json`, find its `stepkit.workflows` map, list the workflow names it
contains) **already exists a second time**, independently, in
`packages/cli/src/internals/workflow-resolution/bundle-resolver.ts` — the module actually used at
*run time* to resolve `stepkit @acme/workflows#release` into a loadable workflow. Reproduced (key
parts):

```ts
// packages/cli/src/internals/workflow-resolution/bundle-resolver.ts
function readStepkitWorkflows(packageJson: unknown, packageName: string): Record<string, string> {
  // validates packageJson.stepkit.workflows shape, same rules as add-command.ts's
  // readBundleWorkflowNames, but returns the full name -> "<modulePath>#<exportName>" map,
  // not just Object.keys(...)
}

function parseManifestTarget(
  target: string, packageName: string, workflowName: string,
): { modulePath: string; exportName: string } {
  // splits "./dist/release.js#releaseWorkflow" into { modulePath: "./dist/release.js", exportName: "releaseWorkflow" }
}
```

`bundle-resolver.ts`'s version is strictly more useful for the scanner (it gives you the actual
*module path* to read source text from, not just the workflow *name*) and it's already the
tested, authoritative resolution-path implementation. **Do not write a third copy of this parsing
logic for the scanner.** Instead (this is a required refactor, not optional cleanup):

1. In `bundle-resolver.ts`, add `export` to `readStepkitWorkflows` and `parseManifestTarget` (they're
   currently private, unexported functions in that file). Rename `readStepkitWorkflows` to something
   library-shaped like `readBundleWorkflowManifest` if you want a clearer public name — your call,
   just update its one call site in the same file if you rename it.
2. In `add-command.ts`, delete `readBundleWorkflowNames` and `resolveBundlePackageJsonPath`'s
   manifest-parsing body, and instead import and call the newly-exported `bundle-resolver.ts`
   functions, deriving the name list via `Object.keys(readBundleWorkflowManifest(...))` where it
   previously computed that itself. `isBundleSource` and `configPathForScope` stay in
   `add-command.ts` unchanged — they're not manifest-parsing logic, they're source-classification and
   scope-path logic specific to `add`.
3. The new scanner module (Sub-feature 2) imports the same exported functions from
   `bundle-resolver.ts` to enumerate every workflow a bundle package contains, including their real
   module file paths.

This consolidation is small (a handful of `export` keywords plus two call-site updates in
`add-command.ts`) but important: without it you'd have *three* independent copies of "how do I read a
bundle package's workflow manifest," and the next person to touch bundle-manifest shape will only
remember to update one or two of them.

### The injectable resolver/runner seam — exact precedent to copy for package-manager integration

File: `packages/cli/src/internals/workflow-skills/skills-cli.ts` (reproduced in full, 79 lines) —
this is how the codebase already solves "call an external CLI tool, but let tests fake it out":

```ts
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type SkillsCliDistributionTarget = "project" | "user";

export type SkillsCliResolver = () => Promise<string>;

export interface SkillsCliRunResult {
  readonly exitCode: number;
}

export type SkillsCliProcessRunner = (
  command: string,
  args: readonly string[],
) => Promise<SkillsCliRunResult>;

export interface DistributeWorkflowSkillInput {
  readonly skillDirectory: string;
  readonly target: SkillsCliDistributionTarget;
  readonly resolver?: SkillsCliResolver;
  readonly runner?: SkillsCliProcessRunner;
}

export async function distributeWorkflowSkill(input: DistributeWorkflowSkillInput): Promise<void> {
  const resolver = input.resolver ?? resolveInstalledSkillsCliPath;
  const runner = input.runner ?? spawnSkillsCliProcess;
  const cliPath = await resolveSkillsCliPath(resolver);
  const args = [
    cliPath, "add", input.skillDirectory, "--agent", "*", "-y",
    ...(input.target === "user" ? ["-g"] : []),
  ];

  const result = await runner(process.execPath, args);
  if (result.exitCode !== 0) {
    throw new Error(`skills CLI exited with code ${result.exitCode}.`);
  }
}

async function spawnSkillsCliProcess(
  command: string, args: readonly string[],
): Promise<SkillsCliRunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
  });
}
```

**Copy this exact shape** for the new package-manager integration in Sub-feature 4: a public type for
the injectable function signature, a real implementation using `node:child_process.spawn` as the
default, and the function accepting an optional override that falls back to the real one. This is
also the same pattern already threaded through `CliCommandContext` (`skillsCliResolver` /
`skillsCliProcessRunner` fields) — you're adding two more fields following the identical pattern, not
inventing a new one.

---

## Sub-feature 0: `peerDependencies` prerequisite

**Why first**: `update`'s self-bump logic (bump `@stepkit/core`, then figure out which `@stepkit/sdk`
version is still compatible) needs *some* machine-readable statement of compatibility to check
against. Today there is none — sdk/cli depend on core only via `workspace:*` (a monorepo-internal
protocol meaningless to an external consumer who `npm install`s the published packages).

**What to do**:

1. Add to `packages/sdk/package.json`, alongside the existing `"dependencies"` block:
   ```json
   "peerDependencies": {
     "@stepkit/core": "^0.0.0"
   }
   ```
   (Use whatever the actual current core major.minor is at the time you implement this — `^0.0.0` is
   illustrative given today's `0.0.0` pre-release state; the real value should track core's actual
   version at release time going forward, same as any peer dependency in any package.)
2. Add the same shape to `packages/cli/package.json` for its dependency on `@stepkit/core`.
3. No `.changeset/config.json` changes needed — `"updateInternalDependencies": "patch"` already
   applies to peer ranges on workspace packages the same way it applies to normal dependency ranges;
   changesets doesn't need to be told peerDependencies exist separately.
4. This is a real, publishable change to two `package.json` files — if this repo's changeset process
   requires a changeset file for any `packages/*` edit (check `.changeset/README.md` or ask a
   teammate if unsure), add one describing "add peerDependencies from sdk/cli onto core" as a patch
   bump for both packages.

**Why not a bespoke StepKit-specific compatibility file instead**: it would require new publish-time
tooling to keep in sync, and would be enforced by *nothing* outside `stepkit update` itself — a
consumer who runs a plain `npm install @stepkit/sdk@latest` directly (bypassing `stepkit update`
entirely) would get zero protection. `peerDependencies` is enforced automatically by npm/pnpm/yarn
themselves the moment it's declared, for every install path, not just ours.

LOE: ~2 hours including a changeset entry if required.

---

## Sub-feature 1: core deprecation manifest schema

**New directory `packages/core/src/deprecations/`**, sibling to `agent-execution/`, `agent-targeting/`,
`authoring/`, `contracts/`, `known-cli-providers/`, `runtime/`.

### 1.1 — Add the `semver` dependency

Add to `packages/core/package.json`'s `"dependencies"`: `"semver": "^7.6.0"` (check npm for the
actual current major at implementation time — `^7` is the long-stable major as of this writing).
Add `"@types/semver": "^7.5.0"` to `"devDependencies"`.

### 1.2 — Types file

New file `packages/core/src/deprecations/deprecations.types.ts`:

```ts
export type DeprecationTargetPackage = "@stepkit/core" | "@stepkit/sdk";

export interface DeprecationEntry {
  /** Which published package exports this symbol. A symbol re-exported by both (like `step`,
   * which sdk re-exports from core) needs one entry per package it's importable from, since a
   * workflow author might import it from either. */
  readonly package: DeprecationTargetPackage;
  /** The exact named export identifier, e.g. "step". Matched literally against import statement
   * text by the scanner — see Sub-feature 2 for exactly how and its known limitations. */
  readonly symbol: string;
  /** Semver version at/after which this symbol is considered deprecated (still works, warns). */
  readonly deprecatedSince: string;
  /** Semver version at/after which this symbol is actually removed (no longer works). Omit if the
   * symbol is deprecated but has no planned removal — it stays warning-tier forever until this
   * field is added in a later manifest update. */
  readonly removedIn?: string;
  /** Human-readable explanation, shown verbatim in doctor/update output. */
  readonly message: string;
  /** Optional suggested replacement API, shown as "Suggested replacement: <this>." */
  readonly replacement?: string;
}

export type DeprecationManifest = readonly DeprecationEntry[];

export interface DeprecationStatus extends DeprecationEntry {
  readonly severity: "warning" | "blocking";
}
```

### 1.3 — The manifest + lookup function

New file `packages/core/src/deprecations/deprecation-manifest.ts`:

```ts
import { lte } from "semver";

import type {
  DeprecationEntry,
  DeprecationManifest,
  DeprecationStatus,
  DeprecationTargetPackage,
} from "./deprecations.types.js";

// Scaffolding only — genuinely empty. No deprecation exists yet in this codebase. Real entries get
// appended here the day a real breaking change to @stepkit/core or @stepkit/sdk's authoring API
// actually happens. Do not add a fake/example entry to this array.
export const deprecationManifest: DeprecationManifest = [];

export interface FindDeprecationsAsOfQuery {
  readonly package: DeprecationTargetPackage;
  readonly version: string;
}

/**
 * Returns every manifest entry for `query.package` whose `deprecatedSince` is at or before
 * `query.version`, tagged with a `severity`. Calling this once with `version` set to a *target*
 * version (rather than the currently-installed one) naturally captures every entry between the
 * installed version and the target, no matter how many majors are being skipped in one update — you
 * do not need a separate "range" function to handle a multi-major jump.
 */
export function findDeprecationsAsOf(
  manifest: DeprecationManifest,
  query: FindDeprecationsAsOfQuery,
): readonly DeprecationStatus[] {
  return manifest
    .filter((entry) => entry.package === query.package && lte(entry.deprecatedSince, query.version))
    .map((entry) => toDeprecationStatus(entry, query.version));
}

function toDeprecationStatus(entry: DeprecationEntry, version: string): DeprecationStatus {
  const isRemoved = entry.removedIn !== undefined && lte(entry.removedIn, version);
  return { ...entry, severity: isRemoved ? "blocking" : "warning" };
}
```

**Walk through why the "cumulative union" property holds, with a concrete example**, since this is
the part most likely to be implemented wrong if you don't internalize it first: suppose the manifest
has two entries — `step` deprecated at `2.0.0` (no `removedIn`), and `oldHelper` deprecated at `2.0.0`
*and* removed at `3.5.0`. A consumer currently on core `1.0.0` runs `stepkit update` targeting core
`4.0.0` — a jump across three majors. Calling `findDeprecationsAsOf(manifest, { package:
"@stepkit/core", version: "4.0.0" })` evaluates both entries against `"4.0.0"`: `step`'s
`deprecatedSince: "2.0.0"` is `<= 4.0.0` → included, severity `"warning"` (no `removedIn`).
`oldHelper`'s `deprecatedSince: "2.0.0"` is `<= 4.0.0` → included; its `removedIn: "3.5.0"` is also
`<= 4.0.0` → severity escalates to `"blocking"`. Both surface in one call, correctly, even though the
jump skipped versions `2.0.0` through `3.9.x` entirely. This is why there's no separate
version-range-walking loop anywhere in this design.

### 1.4 — Export from the package root

Add to `packages/core/src/index.ts`:

```ts
export {
  deprecationManifest,
  findDeprecationsAsOf,
} from "./deprecations/deprecation-manifest.js";
export type {
  DeprecationEntry,
  DeprecationManifest,
  DeprecationStatus,
  DeprecationTargetPackage,
  FindDeprecationsAsOfQuery,
} from "./deprecations/deprecations.types.js";
```

### 1.5 — Tests

New file `packages/core/src/deprecations/deprecation-manifest.test.ts`. At minimum:

- `findDeprecationsAsOf` with an empty manifest returns `[]` for any query (guards the real shipped
  state).
- An entry with only `deprecatedSince` (no `removedIn`) at/below the query version → one status,
  `severity: "warning"`.
- An entry with `removedIn` at/below the query version → `severity: "blocking"`.
- An entry with `removedIn` *above* the query version (deprecated but not yet removed at this
  specific query version) → `severity: "warning"`, not `"blocking"`.
- An entry for `"@stepkit/sdk"` is not returned when querying `"@stepkit/core"`, and vice versa.
- **The multi-major cumulative case from the worked example above** — two entries at different
  versions, query jumps across both, both surface in one call. This is the single most important
  test in this file; do not skip it.

LOE: ~0.5 day including tests.

---

## Sub-feature 2: CLI regex scanner + shared scan-target resolution

**New directory `packages/cli/src/internals/deprecation-scan/`.**

### 2.1 — Token extraction (the regex itself, isolated for its own tests)

New file `packages/cli/src/internals/deprecation-scan/import-specifier-tokens.ts`:

```ts
export function extractImportedSymbolTokens(
  sourceText: string,
  packageSpecifier: string,
): readonly string[] {
  const pattern = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${escapeRegExp(packageSpecifier)}["']`,
    "gu",
  );
  const tokens: string[] = [];

  for (const match of sourceText.matchAll(pattern)) {
    for (const rawToken of (match[1] ?? "").split(",")) {
      const token = rawToken.trim();
      if (token.length > 0) {
        tokens.push(token);
      }
    }
  }

  return tokens;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
```

Matching a manifest entry's `symbol` against these tokens is **exact string equality**. Walk through
what this means concretely for three real-world import styles a workflow author might actually write:

- `import { step } from "@stepkit/core";` → token `"step"` → matches a manifest entry with
  `symbol: "step"`. ✅ This is the case the scanner is built for.
- `import { step as s } from "@stepkit/core";` → token `"step as s"` → does **not** `===` `"step"`.
  **Miss.** This is accepted, documented, not something to fix in this pass — see the "known
  limitations" callout below.
- `import * as core from "@stepkit/core"; core.step(...)` → produces no `{...}` clause at all, so
  `extractImportedSymbolTokens` finds zero tokens for this import. **Miss**, same reasoning.

**Known limitations — document these in the `doctor`/`update` command help text and JSDoc, do not
attempt to fix them in this pass**:
1. Aliased named imports (`{ step as s }`) are invisible to symbol-name matching.
2. Namespace imports (`import * as core from "..."`) are invisible entirely.
3. This only works when the scanned file's import specifiers survive whatever build step produced
   it — a workflow author who bundles/inlines `@stepkit/core` into a single-file output defeats the
   regex completely (there's no `from "@stepkit/core"` string left to find). Most workflow packages
   ship plain unbundled ESM (confirmed by how `discovery.ts`/`bundle-resolver.ts` both just
   `import()` a package's entry file directly, no bundler step assumed anywhere in this codebase), so
   this is expected to be the common case, not the exception — but it's a real boundary of what this
   feature can promise.

### 2.2 — Combine tokens + manifest lookup into findings

New file `packages/cli/src/internals/deprecation-scan/deprecation-scan.types.ts`:

```ts
import type { DeprecationManifest, DeprecationTargetPackage } from "@stepkit/core";

export interface DeprecationScanTarget {
  readonly package: DeprecationTargetPackage;
  readonly installedVersion: string;
  readonly targetVersion: string; // equal to installedVersion for a plain doctor run (no update happening)
}

export interface DeprecationFinding {
  readonly sourceLabel: string; // human-readable: a workflow id, or "project/review", etc.
  readonly package: DeprecationTargetPackage;
  readonly symbol: string;
  readonly severity: "warning" | "blocking";
  readonly deprecatedSince: string;
  readonly removedIn?: string;
  readonly message: string;
  readonly replacement?: string;
  /** false if this symbol was ALREADY at this severity at the installed version — i.e. this isn't
   * a new problem caused by the update being considered, it was already true before. Lets output
   * distinguish "heads up, this update makes something break" from "this was already broken." */
  readonly newlyTriggeredByThisUpdate: boolean;
}

export interface ScanWorkflowSourceForDeprecationsInput {
  readonly sourceLabel: string;
  readonly sourceText: string;
  readonly targets: readonly DeprecationScanTarget[];
  /** Test-only override — production code omits this and gets the real manifest from
   * @stepkit/core. See Sub-feature 3/4's test sections for why this seam exists. */
  readonly manifest?: DeprecationManifest;
}
```

New file `packages/cli/src/internals/deprecation-scan/scan-workflow-source.ts`:

```ts
import { deprecationManifest, findDeprecationsAsOf } from "@stepkit/core";

import { extractImportedSymbolTokens } from "./import-specifier-tokens.js";
import type {
  DeprecationFinding,
  ScanWorkflowSourceForDeprecationsInput,
} from "./deprecation-scan.types.js";

export function scanWorkflowSourceForDeprecations(
  input: ScanWorkflowSourceForDeprecationsInput,
): readonly DeprecationFinding[] {
  const manifest = input.manifest ?? deprecationManifest;
  const findings: DeprecationFinding[] = [];

  for (const target of input.targets) {
    const tokens = extractImportedSymbolTokens(input.sourceText, target.package);
    const tokenSet = new Set(tokens);

    const asOfTarget = findDeprecationsAsOf(manifest, {
      package: target.package,
      version: target.targetVersion,
    });
    const asOfInstalled = new Map(
      findDeprecationsAsOf(manifest, {
        package: target.package,
        version: target.installedVersion,
      }).map((status) => [status.symbol, status]),
    );

    for (const status of asOfTarget) {
      if (!tokenSet.has(status.symbol)) {
        continue;
      }

      const previousStatus = asOfInstalled.get(status.symbol);
      findings.push({
        sourceLabel: input.sourceLabel,
        package: status.package,
        symbol: status.symbol,
        severity: status.severity,
        deprecatedSince: status.deprecatedSince,
        removedIn: status.removedIn,
        message: status.message,
        replacement: status.replacement,
        newlyTriggeredByThisUpdate: previousStatus?.severity !== status.severity,
      });
    }
  }

  return findings;
}
```

Add `packages/cli/src/internals/deprecation-scan/scan-workflow-source.test.ts` covering: a clean
source (no findings), a source matching a warning-tier entry, a source matching a blocking-tier
entry, an aliased import correctly producing zero findings (documents the known limitation as a
passing test, not a bug — name the test something like `"does not detect aliased imports (known
limitation)"` so a future reader understands this is intentional), and a case where
`installedVersion` already had the same severity as `targetVersion` → `newlyTriggeredByThisUpdate:
false`.

### 2.3 — Resolving *which* files to scan

New file `packages/cli/src/internals/deprecation-scan/scan-targets.ts`:

```ts
export interface WorkflowScanTarget {
  readonly sourceLabel: string;
  /** Absolute path to the module file to read source text from. Undefined for a direct-file
   * registry entry that couldn't be resolved, or any other unreadable case — callers must skip
   * targets with no sourceFilePath, not throw. */
  readonly sourceFilePath?: string;
  /** The npm package name backing this target, if any (bundle or plain-package registered, or
   * discovered). Undefined for direct-file entries. */
  readonly packageName?: string;
  /** Set (non-undefined) for a direct-file registered entry — these have no version, so scanning
   * targets should skip them, and update targets should report them, never act on them. */
  readonly skipReason?: string;
}

export async function resolveAllWorkflowScanTargets(options: {
  readonly cwd: string;
  readonly homeDir?: string;
}): Promise<readonly WorkflowScanTarget[]> {
  // 1. loadStepKitProjectConfig(options.cwd) + loadStepKitUserWorkflowRegistry(options.homeDir) —
  //    merge both registries' namespace/name entries into one flat list of { namespace, name, targetRef }.
  // 2. For each targetRef: classify via isDirectWorkflowFileReference(targetRef) (already exists,
  //    packages/cli/src/internals/workflow-resolution/workflow-resolution.ts) into direct-file vs
  //    bundle/plain-package. Direct-file -> { sourceLabel: `${namespace}/${name}`, skipReason:
  //    "local file source, no version to update" }, no sourceFilePath.
  // 3. Bundle/plain-package: if targetRef contains "#", split into packageName + workflowName and
  //    resolve via the newly-exported bundle-resolver.ts functions (readBundleWorkflowManifest +
  //    parseManifestTarget) to get the real module file path. If no "#", treat targetRef itself as
  //    a plain package name whose entry point is resolved the same way discovery.ts resolves a
  //    dependency's entry point (createRequire(...).resolve(`${targetRef}/package.json`) then
  //    resolvePackageEntryFilePath from discovery.ts's new export).
  // 4. Separately, call discoverWorkflows({ cwd: options.cwd }) and add one WorkflowScanTarget per
  //    discovered workflow, using resolvePackageEntryFilePath to get its module file path.
  // 5. Dedup by resolved absolute sourceFilePath (a workflow could in principle be both registered
  //    and auto-discoverable; scan it once).
}

export async function resolveBundleWorkflowScanTargets(
  packageName: string,
  cwd: string,
): Promise<readonly WorkflowScanTarget[]> {
  // Reads the bundle's full workflow manifest via bundle-resolver.ts's exported
  // readBundleWorkflowManifest(packageJson, packageName), and returns one WorkflowScanTarget per
  // workflow name it contains — this is what makes "scan every workflow in the bundle, not just
  // the one named" possible for stepkit update (Sub-feature 4).
}
```

Write these two functions with real bodies following the comments above — the comments describe the
control flow precisely enough to implement directly; they're left as comments here because the exact
line-by-line code depends on small decisions (exact error handling for an unresolvable package, exact
dedup key format) best made while looking at the actual `isDirectWorkflowFileReference` and
`bundle-resolver.ts` signatures side by side in your editor.

Add `packages/cli/src/internals/deprecation-scan/scan-targets.test.ts` — build small fixture
directories (following the existing `skill-check-command.test.ts` temp-dir convention, see Testing
section below) with a `.stepkit/config.json` containing one direct-file entry, one bundle entry with
2+ workflows, and one plain-package entry; assert `resolveAllWorkflowScanTargets` returns the right
count/shape/skip-reasons, and that `resolveBundleWorkflowScanTargets` returns all workflows in a
multi-workflow bundle fixture.

LOE for Sub-feature 2 total (2.1 + 2.2 + 2.3 + the `bundle-resolver.ts`/`discovery.ts` export
refactors from the reference section above): ~1.5–2 days including tests.

---

## Sub-feature 3: `stepkit doctor` command

New directory `packages/cli/src/internals/commands/doctor/`.

### 3.1 — Version resolution helper

You need "what version of `@stepkit/core`/`@stepkit/sdk` is actually installed in this consumer's
`node_modules` right now." Use the exact same trick already used twice elsewhere in this codebase
(`bundle-resolver.ts`'s `resolvePackageJsonPath`, `discovery.ts`'s `resolvePackageJson`):
`createRequire(resolve(cwd, "package.json")).resolve("@stepkit/core/package.json")`, then
`JSON.parse(await readFile(thatPath, "utf8")).version`. Put this in a small new file,
`packages/cli/src/internals/deprecation-scan/resolve-installed-stepkit-versions.ts`, returning
`{ readonly core?: string; readonly sdk?: string }` (both optional — a consumer might not have
`@stepkit/sdk` installed at all if they author directly against core).

### 3.2 — The command

New file `packages/cli/src/internals/commands/doctor/doctor-command.ts`:

```ts
import { readFile } from "node:fs/promises";

import { type CliCommand, type CliCommandContext, CliUsageError } from "../../command.types.js";
import { resolveAllWorkflowScanTargets } from "../../deprecation-scan/scan-targets.js";
import { resolveInstalledStepkitVersions } from "../../deprecation-scan/resolve-installed-stepkit-versions.js";
import { scanWorkflowSourceForDeprecations } from "../../deprecation-scan/scan-workflow-source.js";
import type { DeprecationFinding, DeprecationScanTarget } from "../../deprecation-scan/deprecation-scan.types.js";
import { formatFinding } from "./format-finding.js";

export const doctorCommand: CliCommand<Record<string, never>> = {
  name: "doctor",
  parseArgs(argv: readonly string[]): Record<string, never> {
    if (argv.length !== 1 || argv[0] !== "doctor") {
      throw new CliUsageError("Expected doctor.");
    }
    return {};
  },
  async run(_args, context: CliCommandContext): Promise<number> {
    const installed = await resolveInstalledStepkitVersions(context.cwd);
    const asOfTargets: DeprecationScanTarget[] = [
      ...(installed.core !== undefined
        ? [{ package: "@stepkit/core" as const, installedVersion: installed.core, targetVersion: installed.core }]
        : []),
      ...(installed.sdk !== undefined
        ? [{ package: "@stepkit/sdk" as const, installedVersion: installed.sdk, targetVersion: installed.sdk }]
        : []),
    ];

    const scanTargets = await resolveAllWorkflowScanTargets({ cwd: context.cwd, homeDir: context.homeDir });
    const findings: DeprecationFinding[] = [];

    for (const target of scanTargets) {
      if (target.sourceFilePath === undefined) {
        continue; // direct-file entries and unresolvable targets: nothing to read
      }
      const sourceText = await readFile(target.sourceFilePath, "utf8").catch(() => undefined);
      if (sourceText === undefined) {
        continue; // unreadable/missing file — not doctor's job to flag registry staleness
      }
      findings.push(
        ...scanWorkflowSourceForDeprecations({
          sourceLabel: target.sourceLabel,
          sourceText,
          targets: asOfTargets,
        }),
      );
    }

    if (findings.length === 0) {
      context.io.writeLine("stepkit doctor: no deprecated symbol usage found.");
      return 0;
    }

    for (const finding of findings) {
      context.io.writeLine(formatFinding(finding));
    }

    return findings.some((f) => f.severity === "blocking") ? 2 : 1;
  },
};
```

**Exit code convention — deliberately diverges from `skill-check`'s always-`0`**: `0` clean, `1`
warnings only present, `2` at least one blocking finding present. This lets a CI script distinguish
"heads up" from "hard failure" (`stepkit doctor; if [ $? -eq 2 ]; then exit 1; fi` for a
warn-only-tolerant gate, or simply `stepkit doctor` in a strict `&&` chain to fail on anything at
all).

### 3.3 — Output formatting

New file `packages/cli/src/internals/commands/doctor/format-finding.ts`:

```ts
import type { DeprecationFinding } from "../../deprecation-scan/deprecation-scan.types.js";

export function formatFinding(finding: DeprecationFinding): string {
  const tag = finding.severity === "blocking" ? "[BLOCKING]" : "[WARNING]";
  const versionInfo =
    finding.removedIn === undefined
      ? `deprecatedSince=${finding.deprecatedSince}`
      : `deprecatedSince=${finding.deprecatedSince} removedIn=${finding.removedIn}`;
  const replacementSuffix =
    finding.replacement === undefined ? "" : ` Suggested replacement: ${finding.replacement}.`;

  return `${tag} ${finding.sourceLabel}: ${finding.package}.${finding.symbol} ${versionInfo} — ${finding.message}${replacementSuffix}`;
}
```

Pin this exact format in a dedicated `format-finding.test.ts` — the command-level test in 3.4 will
also assert on exact output lines (following `skill-check-command.test.ts`'s convention of exact
`lines` array equality), so keep this function's output stable once you've written both.

### 3.4 — Register the command

`packages/cli/src/internals/command-registry.ts`:

```ts
import { doctorCommand } from "./commands/doctor/doctor-command.js";
// ...
if (argv[0] === "doctor") {
  return doctorCommand;
}
```

Also add a `stepkit doctor` line to `usageText` in `command.types.ts`.

### 3.5 — Tests

New file `packages/cli/src/internals/commands/doctor/doctor-command.test.ts`, following
`skill-check-command.test.ts`'s exact convention: call the real `main()` export from
`packages/cli/src/index.ts`, build a real temp `cwd` under
`node_modules/.tmp-stepkit-doctor-tests/<task.id>` with real fixture files, assert exact `exitCode` +
`lines`/`errors` arrays.

Since the shipped manifest is empty, you need a way to inject fake entries for a test. **Add a new
optional `CliCommandContext` field `deprecationManifestOverride?: DeprecationManifest`** (test-only —
production code paths never set it, they always end up using the real, currently-empty
`deprecationManifest` from `@stepkit/core`), threaded through to `scanWorkflowSourceForDeprecations`'s
`manifest` parameter. Thread it through `StepkitMainOptions`/`main()` in `packages/cli/src/index.ts`
the same way every other context field is threaded (look at how `skillsCliResolver` flows from
`StepkitMainOptions` into `context` in `main()` — copy that exact pattern).

Minimum test scenarios:
- No `.stepkit/config.json` at all, no discoverable packages → `"stepkit doctor: no deprecated
  symbol usage found."`, exit `0`.
- A registered bundle workflow whose module file contains `import { step } from "@stepkit/core";`,
  with `deprecationManifestOverride` containing one entry for `step` with only `deprecatedSince` set
  → one `[WARNING]` line, exit `1`.
- Same fixture, but the override entry also has `removedIn` at/below the installed core version →
  one `[BLOCKING]` line, exit `2`.
- A direct-file registered entry present in config → produces **no** finding and does not crash
  (proves the `sourceFilePath === undefined` skip path works).
- An aliased import (`import { step as s }`) with a matching manifest entry → no finding (documents
  the known limitation at the command level too, not just the unit level).

LOE for Sub-feature 3: ~1 day including tests.

---

## Sub-feature 4: `stepkit update` command

New directory `packages/cli/src/internals/commands/update/`, plus a new sibling
`packages/cli/src/internals/package-manager/` directory.

### 4.1 — `parseArgs`

```ts
export interface UpdateCommandArgs {
  readonly scope: "self" | "all" | "workflows" | "workflow";
  readonly workflowName?: string; // only meaningful when scope === "workflow"
  readonly force: boolean;
  readonly yes: boolean;
}
```

Flags: `--all`, `--workflows`, `--workflow=<name>` (validate these three are mutually exclusive —
throw `CliUsageError` if more than one is passed), `--force`, `--yes`. No scope flag at all → `scope:
"self"` (bare `stepkit update` means "update stepkit itself," matching how most CLI update commands
default to updating themselves absent other instruction).

### 4.2 — Target resolution

New file `packages/cli/src/internals/commands/update/resolve-update-targets.ts`. Start the file with
this comment verbatim (it prevents a future contributor from "fixing" a perceived omission):

```ts
// This module deliberately never calls discoverWorkflows(). Plain npm stepkit-workflow-keyword
// dependencies are out of scope for `stepkit update` — they are ordinary entries in the consumer's
// own package.json and ride the consumer's normal package-manager update on their whole project.
// `update` only ever acts on entries that went through `stepkit add` (the config registry).
```

```ts
export type UpdateTarget =
  | { readonly kind: "stepkit-self" }
  | {
      readonly kind: "bundle-package";
      readonly packageName: string;
      readonly workflows: readonly WorkflowScanTarget[]; // every workflow this package contains
    }
  | { readonly kind: "skipped-direct-file"; readonly sourceLabel: string };

export async function resolveUpdateTargets(
  args: UpdateCommandArgs,
  options: { readonly cwd: string; readonly homeDir?: string },
): Promise<readonly UpdateTarget[]> {
  // scope "self": return [{ kind: "stepkit-self" }] only.
  // scope "all": [{ kind: "stepkit-self" }, ...targets from the "workflows" branch below].
  // scope "workflows": walk the merged project+project-local+user registry (loadStepKitProjectConfig
  //   + loadStepKitUserWorkflowRegistry), classify every entry via isDirectWorkflowFileReference;
  //   direct-file entries -> { kind: "skipped-direct-file", sourceLabel }; everything else -> resolve
  //   its backing package name (split on "#" if present, else the targetRef itself is the package
  //   name) and produce ONE { kind: "bundle-package", packageName, workflows } per UNIQUE package
  //   name (dedupe — multiple namespace/name registry entries can point at the same package),
  //   using resolveBundleWorkflowScanTargets(packageName, cwd) to enumerate every workflow that
  //   package contains (not just the ones actually registered — the whole package moves together).
  // scope "workflow": resolve args.workflowName first as a "<namespace>/<name>" registry lookup; if
  //   found and its targetRef is a bundle/plain-package ref, extract the package name and produce
  //   ONE { kind: "bundle-package", ... } target the same way as above (still expands to the WHOLE
  //   bundle, never a single workflow in isolation — per the "they move together" requirement). If
  //   found and its targetRef is direct-file, throw CliUsageError("nothing to update — <ref> is a
  //   local file source"). If the registry lookup MISSES entirely, treat args.workflowName itself as
  //   a raw package name and attempt to resolve it as a bundle package directly (supports "the name
  //   can be a bundle package's name, not just a registered namespace/name").
}
```

### 4.3 — Package-manager integration

New directory `packages/cli/src/internals/package-manager/`.

`package-manager.types.ts`:

```ts
export type PackageManagerId = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageManagerCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type PackageManagerCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<PackageManagerCommandResult>;
```

`detect-package-manager.ts` — sniff the consumer's `cwd` for a lockfile: `pnpm-lock.yaml` → `"pnpm"`,
`package-lock.json` → `"npm"`, `yarn.lock` → `"yarn"`, `bun.lockb` → `"bun"`. If none found, fall back
to the consumer's own root `package.json`'s `"packageManager"` field (e.g. `"pnpm@9.0.0"` → parse the
name before `@`) if present; otherwise default to `"npm"` and have the caller print a warning line
("no lockfile or packageManager field found, defaulting to npm").

`npm-registry-client.ts`:

```ts
export async function resolveLatestPublishedVersion(
  packageName: string,
  runner: PackageManagerCommandRunner,
  cwd: string,
): Promise<string> {
  const result = await runner("npm", ["view", packageName, "versions", "--json"], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`npm view failed for ${packageName}: ${result.stderr}`);
  }
  const versions = JSON.parse(result.stdout) as string[];
  // pick the highest STABLE (non-prerelease) semver via semver's rsort/prerelease check
}
```

**Deliberately always shells out to `npm view` regardless of the consumer's detected package
manager** — registry metadata queries work against the npm registry the same way no matter which
package manager the consumer uses day-to-day (pnpm/yarn/bun all still publish to and read from the
same npm registry by default). Only the final *install* step (below) needs to be package-manager
specific. This is a deliberate scope reduction: one query code path instead of four.

`apply-version-bump.ts` — reads the consumer's root `package.json`, for each `{ packageName,
targetVersion }` pair finds the existing dependency/devDependency entry, preserves its existing range
prefix style (`^`, `~`, or exact — inferred by checking the first character(s) of the current value;
default to `^` if the existing value doesn't start with a recognized prefix), rewrites it to
`<prefix><targetVersion>`, writes the file back, then invokes `<packageManagerId> install` via the
injectable `PackageManagerCommandRunner` (`npm install` / `pnpm install` / `yarn install` / `bun
install`). If the install step's exit code is nonzero, surface its captured stderr and return failure
**without claiming success** — note in a code comment that `package.json` was already rewritten by
this point (a known small window where a failed install can leave `package.json` ahead of the
lockfile) and that the documented recovery path is simply re-running the install command, not an
automatic rollback.

### 4.4 — Orchestration

New file `packages/cli/src/internals/commands/update/update-command.ts`. Full control flow, in order:

1. `resolveUpdateTargets(args, { cwd, homeDir })`.
2. For each target, resolve installed + target version(s):
   - `stepkit-self`: read installed `@stepkit/core`/`@stepkit/sdk`/`@stepkit/cli` versions (reuse
     Sub-feature 3.1's `resolveInstalledStepkitVersions`, extended to also cover cli's own version —
     or add a small sibling helper), resolve each package's latest published version via
     `resolveLatestPublishedVersion`. For sdk/cli, additionally check the candidate version's
     published `peerDependencies["@stepkit/core"]` range (fetch via `npm view <pkg>@<version>
     peerDependencies --json`) against the core version you're about to bump *to*, and pick the
     highest sdk/cli version whose peer range accepts it — this is exactly why Sub-feature 0 had to
     land first.
   - `bundle-package`: read the package's own installed version (same `createRequire(...).resolve`
     trick) and its latest published version.
3. **Doctor gate — run before anything is written.** For every target with an actual version change
   (`installedVersion !== targetVersion`):
   - If `stepkit-self`: build `DeprecationScanTarget[]` for `@stepkit/core` and `@stepkit/sdk` (
     `installedVersion` = currently installed, `targetVersion` = what you're about to bump to), and
     scan **every** workflow from `resolveAllWorkflowScanTargets(...)` against those targets.
   - If `bundle-package`: this package's *own* version isn't in the deprecation manifest (the
     manifest only ever tracks `@stepkit/core`/`@stepkit/sdk` symbols) — but its workflows must still
     be checked against whatever core/sdk version is in play for *this same invocation*. Build scan
     targets using the currently-installed core/sdk version as both `installedVersion` and
     `targetVersion` (catches problems that already exist today, regardless of whether core/sdk are
     moving at all), and — **only if this same `update` invocation also includes a `stepkit-self`
     target** — additionally scan against core/sdk's *new* target version. Scan **every** workflow
     `target.workflows` contains (this is what satisfies "must scan every workflow the bundle
     contains, not just the one named" — the whole bundle already expanded to all its workflows back
     in `resolveUpdateTargets`).
   - Collect all findings across all targets into one flat list.
4. Print every finding (both severities) via `formatFinding` (reuse Sub-feature 3.3's formatter
   unchanged).
5. If any finding has `severity: "blocking"`:
   - Without `--force`: `context.io.writeError("stepkit update: blocked by N deprecation finding(s).
     Re-run with --force to override.")`, return `1`. **Nothing has been written yet at this point** —
     verify this in a test (Sub-feature 4.5 below).
   - With `--force`: `context.io.writeError("Warning: proceeding despite blocking deprecation
     findings because --force was set.")`, continue to step 6.
6. Print a dry-run diff: one line per target with an actual version change, `"<packageName>:
   <installedVersion> -> <targetVersion>"`. Also print one line per `skipped-direct-file` target:
   `"Skipped <sourceLabel>: local file source, no version to update."`.
7. Confirmation: if `!args.yes`, and `context.prompts === undefined`, throw
   `CliUsageError("stepkit update requires --yes in non-interactive contexts.")`. Otherwise
   `await context.prompts.select("Apply these updates?", ["yes", "no"])`; if the answer isn't
   `"yes"`, print `"Aborted. No changes made."` and return `0`.
8. Apply: for each target with an actual version change, call `apply-version-bump.ts`'s function with
   the detected package manager (via `detect-package-manager.ts`) and the injectable
   `packageManagerCommandRunner` from context. Surface any failure's stderr and return nonzero without
   claiming success for that target.

### 4.5 — New `CliCommandContext` fields

Add to `packages/cli/src/internals/command.types.ts`, following the exact `skillsCliResolver`/
`skillsCliProcessRunner` precedent from the reference section above:

```ts
import type { PackageManagerCommandRunner } from "./package-manager/package-manager.types.js";
import type { DeprecationManifest } from "@stepkit/core";

// inside CliCommandContext:
packageManagerCommandRunner?: PackageManagerCommandRunner;
deprecationManifestOverride?: DeprecationManifest;
```

Both default to a real implementation when `undefined` — `packageManagerCommandRunner` defaults to a
`node:child_process.spawn`-based runner (mirror `skills-cli.ts`'s `spawnSkillsCliProcess` almost
exactly, just capturing `stdout`/`stderr` into strings instead of using `stdio: "ignore"`, since
`npm view`'s JSON output and install failures' stderr both need to be read, not discarded).
`deprecationManifestOverride` defaults to `undefined`, meaning "use the real manifest" (this field was
already added in Sub-feature 3, threaded through the same way — `update` just also reads it, don't
add it twice).

Thread both through `StepkitMainOptions` and `main()` in `packages/cli/src/index.ts`, same pattern as
every existing context field there.

### 4.6 — Register the command + usage text

`command-registry.ts`:

```ts
import { updateCommand } from "./commands/update/update-command.js";
// ...
if (argv[0] === "update") {
  return updateCommand;
}
```

Add a `stepkit update [--all|--workflows|--workflow=<name>] [--force] [--yes]` line to `usageText`.

### 4.7 — Tests

New files: `resolve-update-targets.test.ts`, `detect-package-manager.test.ts`,
`npm-registry-client.test.ts`, `apply-version-bump.test.ts`, and `update-command.test.ts` (likely
split into several files by scenario, given how many distinct flows this command has — that's fine,
follow whatever splitting convention this codebase already uses for its larger commands).

For `update-command.test.ts`, following the same real-`main()`/real-temp-`cwd` convention as
`skill-check-command.test.ts`, fake `packageManagerCommandRunner` to return canned `npm view ...
versions --json` output (and canned `peerDependencies` output) for `@stepkit/core`/`@stepkit/sdk`/
`@stepkit/cli`, and record the final install invocation without touching the real network or
filesystem beyond the temp project's own files. Minimum scenarios:

- **Self-update** rewrites all three stepkit package.json lines, picks the package manager from a
  fixture lockfile (write an empty `pnpm-lock.yaml` in the fixture to force `pnpm` and assert the
  recorded install invocation used `pnpm install`).
- **`--workflows`** touches only bundle-package lines, leaves core/sdk/cli package.json entries
  untouched.
- **`--workflow=<name>`** resolves correctly via both paths: a registered `namespace/name` lookup,
  and a raw bundle-package-name fallback when the registry lookup misses.
- **`--all` with a direct-file registry entry present** prints the exact `"Skipped ...: local file
  source, no version to update."` line and leaves that entry's (nonexistent) version untouched — it
  should never even attempt to look anything up for it.
- **Blocking-gate scenario**: inject a `deprecationManifestOverride` entry whose `removedIn` is at/
  below the self-update's target core version, matching a fixture workflow's actual import; assert
  the run is blocked, exit code reflects the block, and `package.json` is byte-identical to its
  pre-image (nothing was written). Re-run the same fixture with `--force` and assert it now proceeds,
  printing the "Warning: proceeding despite..." line.
- **Confirmation flow**: `--yes` bypasses the prompt entirely; a fake `context.prompts.select`
  answering `"no"` aborts with no mutation; omitting both `--yes` and `context.prompts` throws
  `CliUsageError`.

LOE for Sub-feature 4: ~3–4 days including all of the above tests — this is the largest single piece
of the whole feature.

---

## Non-goals (explicit — keep this feature scoped)

- **No TypeScript type-checking in the scanner.** Regex/text matching only, with the documented
  aliasing/namespace-import/bundled-output blind spots. Do not expand this into a real type-checker
  as part of this work.
- **No automatic rollback** if a package-manager install fails mid-`update`. The recovery path is
  re-running the install command by hand; do not build automatic `package.json` restoration.
- **No handling of plain npm `stepkit-workflow`-keyword dependencies in `update`.** They are
  explicitly out of scope — normal `npm update`/etc. on the consumer's whole project already covers
  them.
- **No seed/example entries in the shipped deprecation manifest.** It ships genuinely empty.
- **No cross-package-manager translation** beyond the four listed (npm/pnpm/yarn/bun) — an
  unrecognized setup defaults to npm with a printed warning, nothing more elaborate.

## Verification

1. `pnpm --filter @stepkit/core test` and `pnpm --filter @stepkit/cli test` after each sub-feature
   lands — don't wait until the whole feature is done to run tests for the first time.
2. `pnpm typecheck && pnpm lint` across the whole repo once all sub-features land (per `AGENTS.md`:
   touched-package CI isn't implemented, so all-package checks are the safe validation path).
3. Manual smoke test from a scratch consumer-style directory (do this yourself before calling the
   feature done):
   - With no `.stepkit/config.json` and no deprecations installed: `stepkit doctor` →
     `"stepkit doctor: no deprecated symbol usage found."`, exit `0`.
   - Register a bundle workflow via `stepkit add`, run `stepkit update --workflows` with a fake bumped
     version available → confirm the dry-run diff line appears, confirm prompt fires, confirm
     `package.json` updates after answering yes.
   - Repeat with a direct-file registered workflow present alongside the bundle one → confirm the
     skip line appears and that entry is left alone.
4. `node scripts/verify-repository-docs.mjs` and `node scripts/verify-package-metadata.mjs` once
   `package.json` changes (Sub-feature 0's peerDependencies, Sub-feature 1's `semver` dependency) are
   in, since both scripts check repository/package metadata invariants.

## Effort estimate

| Piece | Days |
|---|---|
| Sub-feature 0 — peerDependencies prerequisite | 0.25 |
| Sub-feature 1 — core deprecation manifest scaffolding | 0.5 |
| Sub-feature 2 — scanner + bundle-resolver/discovery export consolidation | 1.5–2 |
| Sub-feature 3 — `stepkit doctor` command | 1 |
| Sub-feature 4 — `stepkit update` command (largest piece) | 3–4 |
| Cross-cutting integration test polish | 1–1.5 |
| **Total** | **~7.5–9.5 days** |

Real ongoing cost beyond this initial build: every future breaking change to `@stepkit/core`/
`@stepkit/sdk`'s authoring API must add a manifest entry in `packages/core/src/deprecations/
deprecation-manifest.ts` — this is a discipline requirement on the team, not a one-time engineering
cost, and nothing in the code enforces someone remembering to do it.
