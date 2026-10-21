/**
 * Thin `run_workflow` tool adapter.
 *
 * Validates workflowRef + input, generates a real run name (same scheme as the
 * CLI's `generate-run-name.ts`), spawns
 * `trailstep <workflowRef> <runName> --input <json>` as a detached background
 * process (the blocking runtime in
 * `@trailstep/core` run-workflow/initialize-run is intentionally NOT awaited),
 * then verifies within a bounded budget (default 2 s, `verifyStartTimeoutMs`)
 * that the background run's directory actually materialized. It returns
 * `{ runId, runDir, status: "started" }` only once the run really exists;
 * otherwise it returns `status: "failed"` with an `error` — never a false
 * "started" for a run that never exists (missing CLI entry, spawn failure, or
 * a background CLI that exits before creating the run).
 *
 * The win32 PATH fallback is refused: cmd.exe would mangle the `--input` JSON,
 * so Windows callers without an explicit `cliEntry` must set
 * `TRAILSTEP_CLI_ENTRY`. With a resolved CLI entry the args are passed without
 * a shell, so the JSON reaches the CLI verbatim on every platform.
 *
 * The generated run name is passed to the CLI as the positional run name, so
 * the spawned run lands in `<runsRoot>/<runName>` and the returned runId/runDir
 * are the real ones the background run writes events.jsonl into.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  deriveWorkflowExportName,
  generateRunName,
  type PlainObject,
  resolveRunsRoot,
} from "@trailstep/core";

import { resolveCliEntry, TRAILSTEP_CLI_ENTRY_ENV } from "./cli-entry.js";

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
  /** Test seam: platform used for the win32 PATH-fallback refusal. Defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Bound (ms) for the post-spawn run-materialization check. Defaults to 2000. */
  readonly verifyStartTimeoutMs?: number;
}

export interface RunWorkflowToolResult {
  readonly runId: string;
  readonly runDir: string;
  /** "started" only once the background run's directory actually exists. */
  readonly status: "started" | "failed";
  /** Why the run never materialized; present when status is "failed". */
  readonly error?: string;
}

const defaultVerifyStartTimeoutMs = 2_000;
const verifyStartPollIntervalMs = 25;

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

  // The canonical run-name scheme: `<readable-name>-<timestamp>-<random-hex>`.
  // The readable name is the workflow export name derived from the raw ref,
  // so the CLI and the MCP name the same workflow's run identically.
  const runName = generateRunName({
    exportName: deriveWorkflowExportName(workflowRef),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomSuffix === undefined ? {} : { randomSuffix: options.randomSuffix }),
  });

  // Runs-root parity with the CLI (`resolveRunsRoot`): env override resolved
  // against the run cwd, else `<cwd>/.trailstep/runs`.
  const runsRoot = resolveRunsRoot({ cwd, env });
  const runDir = join(runsRoot, runName);

  // `trailstep <workflow-ref> [workflowRunName] [--input '<json>']` — the run
  // command is the bare workflow-ref form; there is no `run` subcommand token.
  const runArgs = [workflowRef, runName, "--input", JSON.stringify(input)];
  const cliEntry = resolveCliEntryForTool(options.cliEntry, env);
  const platform = options.platform ?? process.platform;

  // Precheck 1: never let cmd.exe near the --input JSON. The win32 PATH
  // fallback used `shell: true`, which mangles quoted/braced arguments; refuse
  // it with an actionable error instead of spawning a doomed run.
  if (cliEntry === undefined && platform === "win32") {
    return {
      runId: runName,
      runDir,
      status: "failed",
      error: `run_workflow: refusing the win32 PATH fallback because cmd.exe would mangle the --input JSON. Set ${TRAILSTEP_CLI_ENTRY_ENV} to the built @trailstep/cli entry path.`,
    };
  }

  // Precheck 2: an explicitly configured but missing CLI entry can never start
  // a run; report it instead of spawning and guessing.
  if (cliEntry !== undefined && !existsSync(cliEntry)) {
    return {
      runId: runName,
      runDir,
      status: "failed",
      error: `run_workflow: CLI entry not found: ${cliEntry}. Set ${TRAILSTEP_CLI_ENTRY_ENV} to a built @trailstep/cli entry path.`,
    };
  }

  // `trailstep <workflow-ref> [workflowRunName] [--input '<json>']` — the run
  // command is the bare workflow-ref form; there is no `run` subcommand token.
  const usePathFallback = cliEntry === undefined;
  const command = usePathFallback ? "trailstep" : process.execPath;
  const args = usePathFallback ? runArgs : [cliEntry, ...runArgs];

  // Detached background spawn: never await workflow completion here. No shell
  // is ever used (the win32 PATH fallback was refused above), so args arrive at
  // the CLI unmangled.
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  child.unref();

  // Do not report "started" for a run that never exists: verify (bounded) that
  // the background run created its run directory, and surface spawn errors or
  // an early CLI exit instead.
  const verification = await verifyRunMaterialization(
    child,
    runDir,
    options.verifyStartTimeoutMs ?? defaultVerifyStartTimeoutMs,
  );
  if (!verification.ok) {
    return { runId: runName, runDir, status: "failed", error: verification.error };
  }

  return { runId: runName, runDir, status: "started" };
}

type StartVerification = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Bounded post-spawn check that the run actually materializes. Reports OK only
 * once `<runDir>` exists; surfaces a spawn error or a background CLI that
 * exits before creating it. Never waits longer than `budgetMs`, preserving the
 * bounded-time contract. The error/exit listeners attached here also keep a
 * late spawn failure from becoming an unhandled `error` event.
 */
async function verifyRunMaterialization(
  child: ChildProcess,
  runDir: string,
  budgetMs: number,
): Promise<StartVerification> {
  let spawnError: Error | undefined;
  let exitInfo:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
  child.on("error", (error: Error) => {
    spawnError = error;
  });
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  const earlyFailure = (): StartVerification | undefined => {
    if (spawnError !== undefined) {
      return {
        ok: false,
        error: `run_workflow: failed to spawn the background run: ${spawnError.message}`,
      };
    }
    if (exitInfo !== undefined) {
      const how = exitInfo.code === null ? `signal ${exitInfo.signal}` : `code ${exitInfo.code}`;
      return {
        ok: false,
        error: `run_workflow: background CLI exited with ${how} before ${runDir} appeared; not reporting status "started".`,
      };
    }
    return undefined;
  };

  const deadline = Date.now() + Math.max(0, budgetMs);
  while (Date.now() < deadline) {
    if (existsSync(runDir)) {
      return { ok: true };
    }
    const failure = earlyFailure();
    if (failure !== undefined) {
      return failure;
    }
    await sleep(Math.max(1, Math.min(verifyStartPollIntervalMs, deadline - Date.now())));
  }

  if (existsSync(runDir)) {
    return { ok: true };
  }
  const failure = earlyFailure();
  if (failure !== undefined) {
    return failure;
  }
  return {
    ok: false,
    error: `run_workflow: ${runDir} did not appear within ${budgetMs}ms; not reporting status "started" for a run that never materialized.`,
  };
}

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
 * Resolve the trailstep CLI entry to run via `process.execPath`.
 *
 * The shared resolver (see `cli-entry.ts`) handles the explicit option, the
 * `TRAILSTEP_CLI_ENTRY` env override and the running-process detection. The
 * node_modules/workspace walk-up is disabled here on purpose: this tool's
 * win32 PATH-fallback refusal depends on the CLI entry being explicitly
 * configured, so an implicit lookup must not silently replace the PATH
 * fallback with a workspace build.
 */
function resolveCliEntryForTool(
  cliEntry: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const resolved = resolveCliEntry(env, {
    ...(cliEntry === undefined ? {} : { cliEntry }),
    allowWorkspaceLookup: false,
  });
  return resolved === undefined ? undefined : resolve(resolved);
}
