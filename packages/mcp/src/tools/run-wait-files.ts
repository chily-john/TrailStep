/**
 * Run / wait file helpers shared by the MCP trst_answer and trst_resume tools.
 *
 * These mirror the CLI answer/continue seam (resolveRunDirectory ->
 * readEventsForRun -> findPendingWaitsById -> readWaitAnswerFile) from
 * packages/cli/src/internals/commands/wait-run-helpers.ts, backed by the same
 * core readRunEvents reader. The MCP tools must never invent a parallel
 * run_context.json artifact layout: answers live in the run's real wait
 * answer files.
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { type Event, readRunEvents } from "@trailstep/core";

export const TRAILSTEP_RUNS_ROOT_ENV = "TRAILSTEP_RUNS_ROOT";

export interface RunDirectoryContext {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
}

export interface ResolvedRunDirectory {
  readonly runDir: string;
  readonly displayName: string;
}

export function resolveRunsRoot(context: RunDirectoryContext): string {
  const configured = context.env?.[TRAILSTEP_RUNS_ROOT_ENV]?.trim();
  return configured ? resolve(context.cwd, configured) : join(context.cwd, ".trailstep", "runs");
}

export function isPathLike(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  );
}

/**
 * Mirror of the CLI resolveRunDirectory: direct run-dir path first, then the
 * runs-root named candidate. Archived-run awareness is a CLI concern; the MCP
 * tools surface "no events file" through their result errors instead.
 */
export async function resolveRunDirectory(
  runNameOrRunDir: string,
  context: RunDirectoryContext,
): Promise<ResolvedRunDirectory> {
  const directCandidate = isPathLike(runNameOrRunDir)
    ? resolve(context.cwd, runNameOrRunDir)
    : undefined;
  if (directCandidate !== undefined && (await hasEventsFile(directCandidate))) {
    return { runDir: directCandidate, displayName: runNameOrRunDir };
  }

  const namedCandidate = join(resolveRunsRoot(context), runNameOrRunDir);
  if (await hasEventsFile(namedCandidate)) {
    return { runDir: namedCandidate, displayName: runNameOrRunDir };
  }

  if (directCandidate !== undefined) {
    return { runDir: directCandidate, displayName: runNameOrRunDir };
  }

  return { runDir: namedCandidate, displayName: runNameOrRunDir };
}

export async function readEventsForRun(runDir: string): Promise<readonly Event[]> {
  return await readRunEvents(runDir);
}

/**
 * Every unresolved wait.started event with the given waitId, in event order.
 * Same-id waits on different parallel branches are distinct waits, so callers
 * that address a wait must disambiguate by branch instead of picking one.
 */
export function findPendingWaitsById(events: readonly Event[], waitId: string): Event[] {
  const pending: Event[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "wait.started" || event.payload.waitId !== waitId) {
      continue;
    }

    const key = waitEventKey(event);
    const resolvedLater = key
      ? events
          .slice(index + 1)
          .some(
            (laterEvent) =>
              (laterEvent.type === "wait.satisfied" || laterEvent.type === "wait.failed") &&
              waitEventKey(laterEvent) === key,
          )
      : false;
    if (!resolvedLater) {
      pending.push(event);
    }
  }

  return pending;
}

export function findLatestPendingWait(events: readonly Event[]): Event | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "wait.started" || typeof event.payload.waitId !== "string") {
      continue;
    }

    const key = waitEventKey(event);
    const resolvedLater = key
      ? events
          .slice(index + 1)
          .some(
            (laterEvent) =>
              (laterEvent.type === "wait.satisfied" || laterEvent.type === "wait.failed") &&
              waitEventKey(laterEvent) === key,
          )
      : false;
    if (!resolvedLater) {
      return event;
    }
  }

  return undefined;
}

/** Branch identity of a wait event; events without a branch belong to the implicit root branch. */
export function waitEventBranchId(event: Event): string {
  return typeof event.payload.branchId === "string" && event.payload.branchId.length > 0
    ? event.payload.branchId
    : "root";
}

export function readWaitAnswerFile(event: Event): string | undefined {
  const artifactPaths = event.payload.artifactPaths;
  if (!isPlainObject(artifactPaths)) {
    return undefined;
  }

  return typeof artifactPaths.answerFile === "string" ? artifactPaths.answerFile : undefined;
}

/** Verbatim question text of a wait (the wait.started payload message). */
export function readWaitQuestion(event: Event): string | undefined {
  return typeof event.payload.message === "string" ? event.payload.message : undefined;
}

function waitEventKey(event: Event): string | undefined {
  // Branch identity is part of the wait identity so that same-id waits on
  // different parallel branches never resolve each other. Events from
  // non-parallel runs carry no branchId and belong to the implicit root branch.
  const branchId = waitEventBranchId(event);
  const artifactPaths = event.payload.artifactPaths;
  if (isPlainObject(artifactPaths) && typeof artifactPaths.answerFile === "string") {
    return `${branchId}:${artifactPaths.answerFile}`;
  }

  const waitId = typeof event.payload.waitId === "string" ? event.payload.waitId : undefined;
  return event.stepId && waitId ? `${branchId}:${event.stepId}:${waitId}` : undefined;
}

async function hasEventsFile(runDir: string): Promise<boolean> {
  try {
    await access(join(runDir, "events.jsonl"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
