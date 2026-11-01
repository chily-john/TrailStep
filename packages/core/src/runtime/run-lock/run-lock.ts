import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage, isNodeError, isPlainObject } from "../../json/guards.js";

/**
 * Advisory execution lock for one run directory.
 *
 * The lock guarantees that only one process drives a run at a time. It is released when the
 * run process returns — including when the run parks in `waiting`, because a durable wait ends
 * the process and a later `continue` re-acquires. The lock therefore protects against
 * concurrent EXECUTION, not against the run's overall lifetime.
 *
 * A lock left behind by a dead process is detected by pid liveness rather than by cleanup, so
 * a SIGKILL, an OOM, or a power loss cannot permanently brick the run directory.
 */
export const RUN_LOCK_FILE_NAME = "run.lock";

export interface RunLock {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly nonce: string;
}

export type AcquireRunLockResult =
  | { readonly status: "acquired"; readonly lock: RunLock }
  | { readonly status: "held"; readonly lock: RunLock }
  | { readonly status: "stale-replaced"; readonly lock: RunLock; readonly previous: RunLock };

export interface AcquireRunLockOptions {
  readonly runDir: string;
  readonly runId: string;
  /** Test seam. Defaults to `process.pid`. */
  readonly pid?: number;
  /** Test seam. Defaults to `new Date()`. */
  readonly now?: () => Date;
  /** Test seam for pid liveness. Defaults to `isPidAlive`. */
  readonly pidIsAlive?: (pid: number) => boolean;
}

export function runLockPath(runDir: string): string {
  return join(runDir, RUN_LOCK_FILE_NAME);
}

/**
 * Whether a pid currently exists. `EPERM` means the process exists but belongs to another
 * user, which still counts as alive; only `ESRCH` means it is gone.
 *
 * Known limitation: a recycled pid can make a dead run look alive. `startedAt` is recorded so
 * an operator can tell; the lock deliberately prefers a false "alive" over a false "dead",
 * because a false "dead" lets two processes drive one run.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

/** Read the lock, tolerating a missing, partial, or malformed file. Never throws. */
export async function readRunLock(runDir: string): Promise<RunLock | undefined> {
  let contents: string;
  try {
    contents = await readFile(runLockPath(runDir), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // A torn or half-written lock is treated as absent: the writer is either mid-rename or
    // died, and in both cases there is no holder to respect.
    return undefined;
  }

  return isRunLock(parsed) ? parsed : undefined;
}

/** Whether a lock is held by a process that still exists. */
export function isRunLockLive(
  lock: RunLock | undefined,
  pidIsAlive: (pid: number) => boolean = isPidAlive,
): boolean {
  return lock !== undefined && pidIsAlive(lock.pid);
}

/**
 * Take the lock for a run directory.
 *
 * - No lock, or a lock held by a dead pid: acquired (a dead holder's file is replaced).
 * - A lock held by a live pid: `held`, and the caller must not run.
 */
export async function acquireRunLock(
  options: AcquireRunLockOptions,
): Promise<AcquireRunLockResult> {
  const pidIsAlive = options.pidIsAlive ?? isPidAlive;
  const now = options.now ?? (() => new Date());
  const existing = await readRunLock(options.runDir);

  if (existing !== undefined && pidIsAlive(existing.pid)) {
    return { status: "held", lock: existing };
  }

  const timestamp = now().toISOString();
  const lock: RunLock = {
    schemaVersion: 1,
    runId: options.runId,
    pid: options.pid ?? process.pid,
    startedAt: timestamp,
    lastHeartbeatAt: timestamp,
    nonce: randomUUID(),
  };

  await writeRunLockAtomic(options.runDir, lock);

  return existing === undefined
    ? { status: "acquired", lock }
    : { status: "stale-replaced", lock, previous: existing };
}

/**
 * Release the lock, but only if this process still owns it. The `nonce` check stops a slow
 * runner from deleting the lock of the process that legitimately took over after it was
 * declared stale.
 */
export async function releaseRunLock(runDir: string, lock: RunLock): Promise<boolean> {
  const current = await readRunLock(runDir);
  if (current === undefined || current.nonce !== lock.nonce) {
    return false;
  }
  try {
    await unlink(runLockPath(runDir));
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
}

/**
 * tmp + rename in the same directory, so a concurrent `readRunLock` sees either the previous
 * complete lock or the new complete lock and never a partial one.
 */
async function writeRunLockAtomic(runDir: string, lock: RunLock): Promise<void> {
  const target = runLockPath(runDir);
  const tempPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    await rename(tempPath, target);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Could not write the run lock at ${target}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function isRunLock(value: unknown): value is RunLock {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.runId === "string" &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    typeof value.startedAt === "string" &&
    typeof value.lastHeartbeatAt === "string" &&
    typeof value.nonce === "string"
  );
}
