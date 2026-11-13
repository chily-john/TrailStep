/**
 * MCP trst_resume tool.
 *
 * Adapter over the real TrailStep continue path: the tool resolves the run
 * directory with the same helpers the CLI uses, then delegates to the CLI
 * `continue` command entry (the same code path `trailstep continue <run>`
 * executes, which itself drives core runWorkflow continue:{runDir}). It never
 * fabricates a {resumed:true} result without the continue machinery running.
 *
 * The continue is started **detached** and the tool returns as soon as the
 * continue has demonstrably begun: a continue re-enters the whole workflow and
 * spawns agents, so awaiting it inside the MCP request outlived the client's
 * transport timeout, and a retrying agent then started a SECOND continue
 * process on the same run directory. `status` is derived from the run's parsed
 * event trail (never from human-readable CLI prose, whose wording can change).
 */
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type Event,
  findLifecycleTerminalEvent,
  listPendingWaits,
  type ResolvedRunDirectory,
  type RunDirectoryContext,
  readEventsForRun,
  readRunLock,
  resolveRunDirectory,
  selectCurrentLifecycleCycle,
} from "@trailstep/core";

import { resolveCliEntry, TRAILSTEP_CLI_ENTRY_ENV } from "./cli-entry.js";

export { resolveCliEntry, TRAILSTEP_CLI_ENTRY_ENV };

export type ContinueStatus =
  | "completed"
  | "waiting"
  | "cancelled"
  | "failed"
  | "running"
  | "unknown";

export interface TrstResumeOptions {
  /** Run name (under the runs root) or run directory path. */
  readonly runId: string;
  /** Execution cwd for run-directory and workflow resolution. Defaults to process.cwd(). */
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /**
   * Injectable continue runner (test seam). An injected runner is awaited to
   * completion — its result is all the tool has to go on — while the default
   * path starts a detached `trailstep continue` and returns once it began.
   */
  readonly runner?: ContinueRunner;
  /** Bound (ms) for the post-spawn verification that the continue started. Defaults to 2000. */
  readonly verifyStartTimeoutMs?: number;
}

export interface TrstResumeResult {
  readonly resumed: boolean;
  readonly runDir?: string;
  readonly status?: ContinueStatus;
  /** True when the continue is still executing in the background; poll trst_watch. */
  readonly background?: boolean;
  readonly error?: string;
}

export interface ContinueRunnerOptions {
  readonly cliEntry: string;
  readonly runDir: string;
  readonly cwd: string;
  /** Caller-provided env, merged over process.env by the detached spawn. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ContinueRunnerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ContinueRunner = (options: ContinueRunnerOptions) => Promise<ContinueRunnerResult>;

const defaultVerifyStartTimeoutMs = 2_000;
const verifyPollIntervalMs = 50;

export async function trstResume(options: TrstResumeOptions): Promise<TrstResumeResult> {
  const context: RunDirectoryContext = {
    cwd: options.cwd ?? process.cwd(),
    ...(options.env === undefined ? {} : { env: options.env }),
  };

  let resolvedRun: ResolvedRunDirectory;
  try {
    resolvedRun = await resolveRunDirectory(options.runId, context);
  } catch (error) {
    return {
      resumed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // A run directory without events cannot be continued; report instead of
  // spawning a doomed continue process.
  let events: readonly Event[];
  try {
    events = await readEventsForRun(resolvedRun.runDir);
  } catch (error) {
    return {
      resumed: false,
      runDir: resolvedRun.runDir,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const startedEvent = events.find((event) => event.type === "workflow.started");
  if (!startedEvent) {
    return {
      resumed: false,
      runDir: resolvedRun.runDir,
      error: `Run has no workflow.started event: ${resolvedRun.runDir}`,
    };
  }

  // The `TRAILSTEP_CLI_ENTRY` override must also be honored when the tool is
  // called without an explicit env (the MCP server passes none): operators
  // configure it in the server's process environment.
  const cliEntry = resolveCliEntry(context.env ?? process.env);
  if (!cliEntry) {
    return {
      resumed: false,
      runDir: resolvedRun.runDir,
      error: `Could not resolve the @trailstep/cli entry; set ${TRAILSTEP_CLI_ENTRY_ENV}.`,
    };
  }

  const runner = options.runner;
  if (runner !== undefined) {
    // Test seam: keep the injected runner fully blocking in behaviour, so the
    // existing tests keep testing what they were written to test.
    const runResult = await runner({
      cliEntry,
      runDir: resolvedRun.runDir,
      cwd: context.cwd,
      ...(context.env === undefined ? {} : { env: context.env }),
    });
    return await describeContinueResult(resolvedRun.runDir, runResult);
  }

  const started = await spawnContinueDetached({
    cliEntry,
    runDir: resolvedRun.runDir,
    cwd: context.cwd,
    ...(context.env === undefined ? {} : { env: context.env }),
    ...(options.verifyStartTimeoutMs === undefined
      ? {}
      : { verifyStartTimeoutMs: options.verifyStartTimeoutMs }),
  });

  if (started.status === "failed") {
    return {
      resumed: false,
      runDir: resolvedRun.runDir,
      status: "failed",
      ...(started.error === undefined ? {} : { error: started.error }),
    };
  }

  // The continue is running (or already finished). Read the trail to report an
  // accurate status instead of scraping stdout.
  const after = await readEventsForRun(resolvedRun.runDir).catch(() => [] as readonly Event[]);
  const status = statusFromEvents(after);
  return {
    resumed: true,
    runDir: resolvedRun.runDir,
    status,
    ...(status === "running" ? { background: true } : {}),
  };
}

/**
 * Map a **blocking** continue result to a resume result.
 *
 * Used by the injected-runner seam (and available for callers that ran the
 * continue themselves). `status` comes from the run's parsed event trail, never
 * from CLI prose; the prose is consulted only to surface the CLI's own error
 * text when the continue failed.
 */
export async function describeContinueResult(
  runDir: string,
  runResult: ContinueRunnerResult,
): Promise<TrstResumeResult> {
  const events = await readEventsForRun(runDir).catch(() => [] as readonly Event[]);
  const resumed = runResult.exitCode === 0;
  const status: ContinueStatus = resumed ? statusFromEvents(events) : "failed";
  const error =
    resumed && status !== "failed"
      ? undefined
      : (extractContinueError(runResult.stdout, runResult.stderr) ??
        `trailstep continue exited with code ${runResult.exitCode}.`);

  return {
    resumed,
    runDir,
    status,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Starts `trailstep continue` in the background and returns as soon as the continue has
 * demonstrably begun. The previous implementation awaited the whole continue, which took
 * minutes and outlived the MCP client's transport timeout — so the calling agent retried and a
 * second process drove the same run directory.
 *
 * Progress evidence is cheap to observe: the trail grew, or the continue took the run lock
 * (`run.lock` appeared with a new nonce). A child that already exited is decisive: exit code 0
 * means the continue ran to completion, a non-zero code means it failed.
 */
async function spawnContinueDetached(options: {
  readonly cliEntry: string;
  readonly runDir: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly verifyStartTimeoutMs?: number;
}): Promise<{ readonly status: "started" | "failed"; readonly error?: string }> {
  const eventsPath = join(options.runDir, "events.jsonl");
  const before = await statOrUndefined(eventsPath);
  const lockBefore = await readRunLock(options.runDir);

  let exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;

  const child = spawn(process.execPath, [options.cliEntry, "continue", options.runDir], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: "ignore",
    detached: true,
    shell: false,
    windowsHide: true,
  });
  child.on("error", (error: Error) => {
    spawnError = error;
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + (options.verifyStartTimeoutMs ?? defaultVerifyStartTimeoutMs);
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      return { status: "failed", error: `Could not start the continue: ${spawnError.message}` };
    }
    // Progress = the trail grew, or the run lock was taken by the continue.
    const after = await statOrUndefined(eventsPath);
    if (before === undefined ? after !== undefined : (after?.size ?? 0) > before.size) {
      return { status: "started" };
    }
    const lock = await readRunLock(options.runDir);
    if (lock !== undefined && lock.nonce !== lockBefore?.nonce) {
      return { status: "started" };
    }
    if (exit !== undefined) {
      return describeEarlyExit(exit);
    }
    await sleep(Math.max(1, Math.min(verifyPollIntervalMs, deadline - Date.now())));
  }

  if (exit !== undefined) {
    return describeEarlyExit(exit);
  }
  if (spawnError !== undefined) {
    return { status: "failed", error: `Could not start the continue: ${spawnError.message}` };
  }
  // No observable progress and no exit: the continue is alive but slow to start
  // (module load, workflow discovery). Report it as started rather than failing
  // a run that is probably fine.
  return { status: "started" };
}

/**
 * Classify a detached continue that already exited inside the verification window: exit code 0
 * means it ran to completion (the trail is authoritative for the resulting status), a non-zero
 * code means it failed before producing any new events.
 */
function describeEarlyExit(exit: {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}): { readonly status: "started" | "failed"; readonly error?: string } {
  if (exit.code === 0) {
    return { status: "started" };
  }
  const how = exit.code === null ? `signal ${exit.signal}` : `code ${exit.code}`;
  return {
    status: "failed",
    error: `trailstep continue exited with ${how} before producing new events.`,
  };
}

/**
 * Status derived from the trail, never from CLI prose.
 *
 * This is the resume vocabulary (`running` / `waiting` / terminal), not the
 * full evidence state: an open run is "running" because its current lifecycle
 * cycle has no terminal event yet. That says nothing about whether a continue
 * process is still alive — the caller follows up with `trst_watch`, whose
 * classifier reports a live owner, a crash, or `unknown` from the real
 * artifacts.
 *
 * The current cycle starts after the latest `workflow.resumed` or
 * `workflow.retryStarted`. A terminal event wins; a cancellation request is
 * **not** terminal on its own, so while one is pending in the current cycle
 * this never reports waiting (answering a wait would discard the request). A
 * request superseded by a reopen is ignored.
 */
export function statusFromEvents(events: readonly Event[]): ContinueStatus {
  const cycleEvents = selectCurrentLifecycleCycle(events);
  const terminal = findLifecycleTerminalEvent(cycleEvents);
  if (terminal !== undefined) {
    return terminal.state;
  }
  if (cycleEvents.some((entry) => entry.type === "workflow.cancelRequested")) {
    return "running";
  }
  if (listPendingWaits(cycleEvents).length > 0) {
    return "waiting";
  }
  return events.length === 0 ? "unknown" : "running";
}

async function statOrUndefined(targetPath: string): Promise<Stats | undefined> {
  try {
    return await stat(targetPath);
  } catch {
    return undefined;
  }
}

function extractContinueError(stdout: string, stderr: string): string | undefined {
  const lines = [...stderr.split("\n"), ...stdout.split("\n")]
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[0];
}
