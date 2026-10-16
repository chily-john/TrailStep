/**
 * MCP trst_answer tool.
 *
 * Adapter over the CLI answer seam: resolveRunDirectory -> readEventsForRun ->
 * findPendingWaitsById -> readWaitAnswerFile -> write the real wait answer
 * file. There is no run_context.json side-channel: answers are persisted into
 * the run's actual wait answer artifact so a later continue (trst_resume or
 * `trailstep continue`) consumes them.
 *
 * Waiting-state results carry the verbatim question text of the pending wait
 * plus the exact submitted recommendation, unmodified.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Event, PlainObject } from "@trailstep/core";

import {
  findPendingWaitsById,
  type ResolvedRunDirectory,
  type RunDirectoryContext,
  readEventsForRun,
  readWaitAnswerFile,
  readWaitQuestion,
  resolveRunDirectory,
  waitEventBranchId,
} from "./run-wait-files.js";
import { type TrstResumeResult, trstResume } from "./trst_resume.js";

export interface TrstAnswerOptions {
  /** Run name (under the runs root) or run directory path. */
  readonly runId: string;
  readonly waitId: string;
  /** Answer payload persisted into the wait answer file; must be a plain JSON object. */
  readonly answer: PlainObject;
  /** Disambiguates same-id waits pending on parallel branches. */
  readonly branchId?: string;
  /** Execution cwd for run-directory resolution. Defaults to process.cwd(). */
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /** After persisting, run the same continue path trst_resume uses. */
  readonly continueAfterAnswer?: boolean;
}

export interface TrstAnswerResult {
  /** True only when the answer was written to the run's real wait answer file. */
  readonly persisted: boolean;
  readonly runDir?: string;
  readonly waitId?: string;
  readonly branchId?: string;
  /** Run-relative wait answer artifact path that received the answer. */
  readonly answerFile?: string;
  /** Verbatim question text of the pending wait (wait.started payload message). */
  readonly question?: string;
  /** Exact submitted recommendation, serialized verbatim (never rewritten). */
  readonly recommendation?: string;
  /** Present when continueAfterAnswer was requested. */
  readonly continued?: TrstResumeResult;
  readonly error?: string;
}

export async function trstAnswer(options: TrstAnswerOptions): Promise<TrstAnswerResult> {
  const context: RunDirectoryContext = {
    cwd: options.cwd ?? process.cwd(),
    ...(options.env === undefined ? {} : { env: options.env }),
  };

  if (!isPlainObject(options.answer)) {
    return {
      persisted: false,
      waitId: options.waitId,
      error: "Wait answer must be a plain JSON object (same rule as `trailstep answer`).",
    };
  }

  let resolvedRun: ResolvedRunDirectory;
  try {
    resolvedRun = await resolveRunDirectory(options.runId, context);
  } catch (error) {
    return {
      persisted: false,
      waitId: options.waitId,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let events: readonly Event[];
  try {
    events = await readEventsForRun(resolvedRun.runDir);
  } catch (error) {
    return {
      persisted: false,
      runDir: resolvedRun.runDir,
      waitId: options.waitId,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const pendingWaits = findPendingWaitsById(events, options.waitId);
  const candidates =
    options.branchId === undefined
      ? pendingWaits
      : pendingWaits.filter((event) => waitEventBranchId(event) === options.branchId);

  if (candidates.length === 0) {
    // Open behavior, deliberately not invented: answering without a matching
    // pending wait does not fabricate a wait file or a persisted=true result.
    return {
      persisted: false,
      runDir: resolvedRun.runDir,
      waitId: options.waitId,
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      error:
        options.branchId === undefined
          ? `Pending wait not found: ${options.waitId} in run ${resolvedRun.displayName}.`
          : `Pending wait not found: ${options.waitId} on branch ${options.branchId} in run ${resolvedRun.displayName}.`,
    };
  }

  if (candidates.length > 1) {
    const branchIds = [...new Set(candidates.map(waitEventBranchId))];
    return {
      persisted: false,
      runDir: resolvedRun.runDir,
      waitId: options.waitId,
      error: `Ambiguous wait id ${options.waitId} is pending on ${candidates.length} waits across branches: ${branchIds.join(
        ", ",
      )}. Re-run with a branchId.`,
    };
  }

  const waitStarted = candidates[0];
  if (!waitStarted) {
    return {
      persisted: false,
      runDir: resolvedRun.runDir,
      waitId: options.waitId,
      error: `Pending wait not found: ${options.waitId} in run ${resolvedRun.displayName}.`,
    };
  }

  const answerFile = readWaitAnswerFile(waitStarted);
  if (!answerFile) {
    return {
      persisted: false,
      runDir: resolvedRun.runDir,
      waitId: options.waitId,
      error: `Wait ${options.waitId} in run ${resolvedRun.displayName} has no answer artifact.`,
    };
  }

  const branchId = waitEventBranchId(waitStarted);
  const answerPath = join(resolvedRun.runDir, answerFile);
  await atomicWriteJson(answerPath, options.answer);

  const continued = options.continueAfterAnswer
    ? await trstResume({
        runId: resolvedRun.runDir,
        cwd: context.cwd,
        env: context.env,
      })
    : undefined;

  return {
    persisted: true,
    runDir: resolvedRun.runDir,
    waitId: options.waitId,
    branchId,
    answerFile,
    question: readWaitQuestion(waitStarted),
    recommendation: JSON.stringify(options.answer),
    ...(continued === undefined ? {} : { continued }),
  };
}

/**
 * Atomic write (temp file + rename in the same directory) so a concurrent
 * continue never reads a half-written answer file.
 */
async function atomicWriteJson(path: string, answer: PlainObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(answer, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
