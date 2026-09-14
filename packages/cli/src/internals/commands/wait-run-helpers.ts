import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Event } from "@trailstep/core";
import { readRunEvents } from "@trailstep/core";
import type { CliCommandContext } from "../command.types.js";
import { CliUsageError } from "../command.types.js";
import { resolveRunsRoot } from "../runs-root.js";

export interface ResolvedRunDirectory {
  readonly runDir: string;
  readonly displayName: string;
}

export async function resolveRunDirectory(
  runNameOrRunDir: string,
  context: Pick<CliCommandContext, "cwd" | "env">,
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

  if (
    !isPathLike(runNameOrRunDir) &&
    (await hasArchivedRunManifest(resolveRunsRoot(context), runNameOrRunDir))
  ) {
    throw new CliUsageError(
      `Run ${runNameOrRunDir} is archived. Restore it with:\n  trailstep storage restore ${runNameOrRunDir}`,
    );
  }

  if (directCandidate !== undefined) {
    return { runDir: directCandidate, displayName: runNameOrRunDir };
  }

  return { runDir: namedCandidate, displayName: runNameOrRunDir };
}

export async function readEventsForRun(runDir: string): Promise<readonly Event[]> {
  return await readRunEvents(runDir);
}

export function findPendingWaitById(events: readonly Event[], waitId: string): Event | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
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
      return event;
    }
  }

  return undefined;
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

export async function writeRunWorkflowRef(runDir: string, workflowRef: string): Promise<void> {
  await writeFile(
    join(runDir, "workflow-ref.json"),
    `${JSON.stringify({ workflowRef }, null, 2)}\n`,
    "utf8",
  );
}

export async function readRunWorkflowRef(runDir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(runDir, "workflow-ref.json"), "utf8"));
    if (isPlainObject(parsed) && typeof parsed.workflowRef === "string") {
      return parsed.workflowRef;
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  return undefined;
}

export function readWaitAnswerFile(event: Event): string | undefined {
  const artifactPaths = event.payload.artifactPaths;
  if (!isPlainObject(artifactPaths)) {
    return undefined;
  }

  return typeof artifactPaths.answerFile === "string" ? artifactPaths.answerFile : undefined;
}

function isPathLike(value: string): boolean {
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

async function hasEventsFile(runDir: string): Promise<boolean> {
  try {
    await access(join(runDir, "events.jsonl"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasArchivedRunManifest(runsRoot: string, runId: string): Promise<boolean> {
  try {
    await access(join(runsRoot, ".archive", `${runId}.manifest.json`), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function waitEventKey(event: Event): string | undefined {
  const artifactPaths = event.payload.artifactPaths;
  if (isPlainObject(artifactPaths) && typeof artifactPaths.answerFile === "string") {
    return artifactPaths.answerFile;
  }

  const waitId = typeof event.payload.waitId === "string" ? event.payload.waitId : undefined;
  return event.stepId && waitId ? `${event.stepId}:${waitId}` : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
