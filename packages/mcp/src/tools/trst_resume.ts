/**
 * MCP trst_resume tool.
 *
 * Adapter over the real TrailStep continue path: the tool resolves the run
 * directory with the same helpers the CLI uses, then delegates to the CLI
 * `continue` command entry (the same code path `trailstep continue <run>`
 * executes, which itself drives core runWorkflow continue:{runDir}). It never
 * fabricates a {resumed:true} result without the continue machinery running.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Event } from "@trailstep/core";

import {
  type ResolvedRunDirectory,
  type RunDirectoryContext,
  readEventsForRun,
  resolveRunDirectory,
} from "./run-wait-files.js";

export const TRAILSTEP_CLI_ENTRY_ENV = "TRAILSTEP_CLI_ENTRY";

export type ContinueStatus = "completed" | "waiting" | "cancelled" | "failed" | "unknown";

export interface TrstResumeOptions {
  /** Run name (under the runs root) or run directory path. */
  readonly runId: string;
  /** Execution cwd for run-directory and workflow resolution. Defaults to process.cwd(). */
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /**
   * Injectable continue runner (test seam). The default runner spawns
   * `node <cliEntry> continue <runDir>` and captures its output.
   */
  readonly runner?: ContinueRunner;
}

export interface TrstResumeResult {
  readonly resumed: boolean;
  readonly runDir?: string;
  readonly status?: ContinueStatus;
  readonly error?: string;
}

export interface ContinueRunnerOptions {
  readonly cliEntry: string;
  readonly runDir: string;
  readonly cwd: string;
}

export interface ContinueRunnerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ContinueRunner = (options: ContinueRunnerOptions) => Promise<ContinueRunnerResult>;

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

  const cliEntry = resolveCliEntry(context.env);
  if (!cliEntry) {
    return {
      resumed: false,
      runDir: resolvedRun.runDir,
      error: `Could not resolve the @trailstep/cli entry; set ${TRAILSTEP_CLI_ENTRY_ENV}.`,
    };
  }

  const runner =
    options.runner ??
    (async (runnerOptions: ContinueRunnerOptions): Promise<ContinueRunnerResult> =>
      await spawnContinue(runnerOptions));

  const runResult = await runner({
    cliEntry,
    runDir: resolvedRun.runDir,
    cwd: context.cwd,
  });

  const status = readContinueStatus(runResult.stdout, runResult.stderr, runResult.exitCode);
  const resumed = runResult.exitCode === 0;
  const error =
    resumed && status !== "failed"
      ? undefined
      : (extractContinueError(runResult.stdout, runResult.stderr) ??
        `trailstep continue exited with code ${runResult.exitCode}.`);

  return {
    resumed,
    runDir: resolvedRun.runDir,
    ...(status === undefined ? {} : { status }),
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Resolves the @trailstep/cli package entry that owns the real continue
 * command. Order: explicit env override, then a walk-up search that covers the
 * pnpm workspace layout (packages/cli/dist) and node_modules installs.
 */
export function resolveCliEntry(env?: Record<string, string | undefined>): string | undefined {
  const override = env?.[TRAILSTEP_CLI_ENTRY_ENV]?.trim();
  if (override) {
    return override;
  }

  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const nodeModulesCandidate = join(
      current,
      "node_modules",
      "@trailstep",
      "cli",
      "dist",
      "index.js",
    );
    if (existsSync(nodeModulesCandidate)) {
      return nodeModulesCandidate;
    }

    const workspaceCandidate = join(current, "packages", "cli", "dist", "index.js");
    if (existsSync(workspaceCandidate)) {
      return workspaceCandidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function spawnContinue(options: ContinueRunnerOptions): Promise<ContinueRunnerResult> {
  return await new Promise<ContinueRunnerResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [options.cliEntry, "continue", options.runDir], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function readContinueStatus(
  stdout: string,
  stderr: string,
  exitCode: number,
): ContinueStatus | undefined {
  if (exitCode !== 0) {
    return "failed";
  }

  const combined = `${stdout}\n${stderr}`;
  if (combined.includes("Workflow completed:")) {
    return "completed";
  }
  if (combined.includes("Workflow cancelled:")) {
    return "cancelled";
  }
  if (combined.includes("Workflow waiting:") || combined.includes("Workflow still waiting:")) {
    return "waiting";
  }
  if (combined.includes("Workflow failed:")) {
    return "failed";
  }

  return "unknown";
}

function extractContinueError(stdout: string, stderr: string): string | undefined {
  const lines = [...stderr.split("\n"), ...stdout.split("\n")]
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[0];
}
