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
import { join } from "node:path";

import {
  type Event,
  findPendingWaitsById,
  type PlainObject,
  type ResolvedRunDirectory,
  type RunDirectoryContext,
  readEventsForRun,
  readWaitAnswerFile,
  readWaitQuestion,
  resolveRunDirectory,
  waitEventBranchId,
  writeWaitAnswerFile,
} from "@trailstep/core";

import { type ContinueRunner, type TrstResumeResult, trstResume } from "./trst_resume.js";

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
  /** Test seam: continue runner passed through to trstResume (mirrors TrstResumeOptions.runner). */
  readonly resumeRunner?: ContinueRunner;
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
  await writeWaitAnswerFile(answerPath, options.answer);

  // The continue step runs AFTER the answer is persisted; a throwing continue
  // path must never discard the persisted-answer report — surface the failure
  // inside `continued` instead of rejecting the whole call.
  let continued: TrstResumeResult | undefined;
  if (options.continueAfterAnswer) {
    try {
      continued = await trstResume({
        runId: resolvedRun.runDir,
        cwd: context.cwd,
        ...(context.env === undefined ? {} : { env: context.env }),
        ...(options.resumeRunner === undefined ? {} : { runner: options.resumeRunner }),
      });
    } catch (error) {
      continued = {
        resumed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

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
 * Strict plain-object check (the answer payload must be a plain JSON object).
 */
function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
