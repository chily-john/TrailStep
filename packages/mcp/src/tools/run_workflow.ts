/**
 * Thin `run_workflow` tool adapter.
 *
 * Validates workflowRef + input, generates a real run name (same scheme as the
 * CLI's `generate-run-name.ts`), spawns
 * `trailstep <workflowRef> <runName> --input <json>` as a detached background
 * process (the blocking runtime in
 * `@trailstep/core` run-workflow/initialize-run is intentionally NOT awaited),
 * and returns `{ runId, runDir, status: "started" }` in bounded time.
 *
 * The generated run name is passed to the CLI as the positional run name, so
 * the spawned run lands in `<runsRoot>/<runName>` and the returned runId/runDir
 * are the real ones the background run writes events.jsonl into.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { PlainObject } from "@trailstep/core";

export interface RunWorkflowToolOptions {
  /** Workflow reference (package id, bundle id, or direct workflow file path). */
  readonly workflowRef: string;
  /** Workflow input; must be a plain JSON object when provided. */
  readonly input?: unknown;
  /** Project directory the run executes in. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Environment for the background run. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Absolute path to the trailstep CLI entry (e.g. packages/cli/dist/index.js). */
  readonly cliEntry?: string;
  /** Test seam mirroring the CLI's run-name clock. */
  readonly now?: () => Date;
  /** Test seam mirroring the CLI's run-name random suffix. */
  readonly randomSuffix?: () => string;
}

export interface RunWorkflowToolResult {
  readonly runId: string;
  readonly runDir: string;
  readonly status: "started";
}

/** Legacy-compatible alias for the run_workflow tool result. */
export type RunWorkflowResult = RunWorkflowToolResult;

const TRAILSTEP_RUNS_ROOT_ENV = "TRAILSTEP_RUNS_ROOT";
const TRAILSTEP_CLI_ENTRY_ENV = "TRAILSTEP_CLI_ENTRY";

export async function runWorkflowTool(
  options: RunWorkflowToolOptions,
): Promise<RunWorkflowToolResult> {
  const workflowRef = validateWorkflowRef(options.workflowRef);
  const input = validateInput(options.input);
  const cwd = options.cwd ?? process.cwd();
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
  };

  const runName = generateRunName({
    workflowRef,
    now: options.now,
    randomSuffix: options.randomSuffix,
  });

  // Runs-root parity with the CLI (`resolveRunsRoot`): env override resolved
  // against the run cwd, else `<cwd>/.trailstep/runs`.
  const configuredRunsRoot = env[TRAILSTEP_RUNS_ROOT_ENV]?.trim();
  const runsRoot = configuredRunsRoot
    ? resolve(cwd, configuredRunsRoot)
    : join(cwd, ".trailstep", "runs");
  const runDir = join(runsRoot, runName);

  // `trailstep <workflow-ref> [workflowRunName] [--input '<json>']` — the run
  // command is the bare workflow-ref form; there is no `run` subcommand token.
  const runArgs = [workflowRef, runName, "--input", JSON.stringify(input)];
  const cliEntry = resolveCliEntry(options.cliEntry, env);
  const usePathFallback = cliEntry === undefined;
  const command = usePathFallback
    ? process.platform === "win32"
      ? "trailstep.cmd"
      : "trailstep"
    : process.execPath;
  const args = usePathFallback ? runArgs : [cliEntry, ...runArgs];

  // Detached background spawn: never await workflow completion here.
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: usePathFallback && process.platform === "win32",
  });
  child.on("error", () => {
    // Background start failures must not crash the MCP server process.
  });
  child.unref();

  return { runId: runName, runDir, status: "started" };
}

/** Legacy-compatible alias: quick-return run_workflow entry. */
export const runWorkflow = runWorkflowTool;

function validateWorkflowRef(workflowRef: unknown): string {
  if (typeof workflowRef !== "string" || workflowRef.trim() === "") {
    throw new Error("run_workflow: workflowRef must be a non-empty string.");
  }
  return workflowRef.trim();
}

function validateInput(input: unknown): PlainObject {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("run_workflow: input must be a JSON object.");
  }
  return input as PlainObject;
}

/**
 * Resolve the trailstep CLI entry to run via `process.execPath`:
 * explicit option, then TRAILSTEP_CLI_ENTRY env, then the running process when
 * it IS the trailstep CLI (`trailstep mcp` foreground server). Falls back to
 * spawning `trailstep` from PATH when none resolve.
 */
function resolveCliEntry(
  cliEntry: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const fromOptions = cliEntry?.trim();
  if (fromOptions) {
    return resolve(fromOptions);
  }
  const fromEnv = env[TRAILSTEP_CLI_ENTRY_ENV]?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  return detectCliEntryFromProcess();
}

function detectCliEntryFromProcess(): string | undefined {
  const entry = process.argv[1];
  if (!entry) {
    return undefined;
  }
  const resolvedEntry = resolve(entry);
  if (basename(resolvedEntry) !== "index.js" || !existsSync(resolvedEntry)) {
    return undefined;
  }
  try {
    const packageJsonPath = join(dirname(resolvedEntry), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return packageJson.name === "@trailstep/cli" ? resolvedEntry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Real run ids — same scheme as the CLI's
 * `packages/cli/src/internals/commands/run/generate-run-name.ts`
 * (`<readable-name>-<timestamp>-<random-hex>`), kept local because the mcp
 * package must not depend on the cli package (cli already depends on mcp).
 */
function generateRunName(options: {
  readonly workflowRef: string;
  readonly now?: () => Date;
  readonly randomSuffix?: () => string;
}): string {
  const date = options.now?.() ?? new Date();
  const timestamp = date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "")
    .replace("T", "-");
  const readableName = slugify(deriveReadableName(options.workflowRef));
  const suffix = slugify(options.randomSuffix?.() ?? randomBytes(4).toString("hex"));
  return `${readableName}-${timestamp}-${suffix}`;
}

function deriveReadableName(workflowRef: string): string {
  const separatorIndex = workflowRef.lastIndexOf(":");
  const exportName = separatorIndex >= 0 ? workflowRef.slice(separatorIndex + 1) : undefined;
  if (exportName && !exportName.includes("/") && !exportName.includes("\\")) {
    return exportName;
  }
  const base = basename(workflowRef);
  return base.replace(/\.[^.]+$/u, "") || workflowRef;
}

function slugify(value: string): string {
  const slug = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug === "" ? "workflow" : slug;
}
