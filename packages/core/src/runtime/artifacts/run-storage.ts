import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Event } from "../../contracts/events/event.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { isNodeError, isPlainObject } from "../../json/guards.js";

export type { Event } from "../../contracts/events/event.types.js";

export type RunState = Record<string, unknown>;

/** Name of the per-project TrailStep state directory (e.g. `<cwd>/.trailstep`). */
export const TRAILSTEP_DIR_NAME = ".trailstep";

export function defaultRunsRoot(cwd: string): string {
  return join(cwd, TRAILSTEP_DIR_NAME, "runs");
}

/**
 * Creates a fresh run directory under the runs root.
 *
 * - `runName`: caller-chosen base name for the run (validated; defaults to the
 *   workflow id via callers). It is the first choice for the directory name.
 * - `runId`: the unique name actually used — `runName`, or `runName-<n>` when
 *   a previous run already took the base name (n increments until free).
 * - `runDir`: the absolute path of the new run directory
 *   (`<runsRoot>/<runId>`) where events.jsonl and other artifacts are written.
 */
export async function createRunDirectory(options: {
  readonly cwd: string;
  readonly runName: string;
  readonly runsRoot?: string;
}): Promise<{ runId: string; runDir: string }> {
  const runsRoot = options.runsRoot ?? defaultRunsRoot(options.cwd);
  validateRunName(options.runName);
  await mkdir(runsRoot, { recursive: true });
  await ensureTrailStepGitignoreForRunsRoot(runsRoot);

  for (let suffix = 1; ; suffix += 1) {
    const runId = suffix === 1 ? options.runName : `${options.runName}-${suffix}`;
    const runDir = join(runsRoot, runId);

    try {
      await mkdir(runDir);
      return { runId, runDir };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }

      throw error;
    }
  }
}

export async function appendEvent(runDir: string, event: Event): Promise<void> {
  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export async function readRunEvents(runDir: string): Promise<Event[]> {
  let contents: string;
  try {
    contents = await readFile(join(runDir, "events.jsonl"), "utf8");
  } catch (error) {
    if (isNodeError(error)) {
      throw new TrailStepFailureError({
        code: "resume_target_not_found",
        message: `Resume target not found or unreadable: ${join(runDir, "events.jsonl")}.`,
        details: { runDir, causeCode: error.code },
      });
    }

    throw error;
  }

  const rawLines = contents.split("\n");
  const lines = rawLines.filter((line, index) => line.length > 0 || index < rawLines.length - 1);
  const events: Event[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    try {
      events.push(JSON.parse(line) as Event);
    } catch (error) {
      const isTrailingLine = index === lines.length - 1;
      if (isTrailingLine) {
        return events;
      }

      throw error;
    }
  }

  return events;
}

/** One complete event line of a run's `events.jsonl` trail. */
export interface RunEventLineEntry {
  /** Raw JSONL line text (without the trailing newline). */
  readonly line: string;
  /** Parsed event carried by the line. */
  readonly event: Event;
  /** Byte offset just past this line's newline (the next read cursor value). */
  readonly endOffset: number;
}

/** Outcome of an incremental read of a run's `events.jsonl` trail. */
export interface RunEventsReadState {
  /** Full file text (used for run-state classification). */
  readonly text: string;
  /** Byte offset just past the last complete line (or `startCursor` if none). */
  readonly offset: number;
  /** Complete, well-formed event lines parsed since `startCursor`. */
  readonly entries: readonly RunEventLineEntry[];
}

function isEventLike(value: unknown): value is Event {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    readonly id?: unknown;
    readonly type?: unknown;
    readonly timestamp?: unknown;
    readonly payload?: unknown;
  };

  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

/**
 * Reads complete event lines from an `events.jsonl` trail since a byte cursor
 * (the seam behind watch-style long polling). Partial trailing lines are left
 * for the next read; a file that shrank (truncated/recreated) restarts from
 * offset 0. Malformed or non-event lines are reported through `options.report`
 * and skipped instead of aborting the read.
 */
export async function readRunEventsSince(
  eventsFile: string,
  startCursor: number,
  options: { readonly report?: (message: string) => void } = {},
): Promise<RunEventsReadState> {
  const buffer = await readFile(eventsFile);
  if (buffer.length < startCursor) {
    return readRunEventsSince(eventsFile, 0, options);
  }

  const text = buffer.toString("utf8");
  const sliceText = buffer.subarray(startCursor).toString("utf8");
  const lastLineBreakIndex = sliceText.lastIndexOf("\n");
  if (lastLineBreakIndex === -1) {
    return { text, offset: startCursor, entries: [] };
  }

  const completeText = sliceText.slice(0, lastLineBreakIndex + 1);
  const entries: RunEventLineEntry[] = [];
  const report = options.report ?? (() => undefined);
  let consumedBytes = 0;
  const lines = completeText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    const lineBytes = Buffer.byteLength(line, "utf8");
    const endOffset = startCursor + consumedBytes + lineBytes + 1; // + newline
    consumedBytes += lineBytes + 1;
    if (line.trim().length === 0) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);
      if (!isEventLike(parsed)) {
        report(`Unexpected event shape in ${eventsFile}: line ${index + 1}. Skipping line.`);
        continue;
      }
      entries.push({ line, event: parsed as Event, endOffset });
    } catch {
      report(`Unable to parse event JSONL in ${eventsFile}: line ${index + 1}. Skipping line.`);
    }
  }

  return {
    text,
    offset: startCursor + Buffer.byteLength(completeText, "utf8"),
    entries,
  };
}

export async function persistEvents(runDir: string, events: readonly Event[]): Promise<void> {
  const jsonl = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(join(runDir, "events.jsonl"), `${jsonl}\n`, "utf8");
}

export async function writeDocumentArtifact(
  dir: string,
  filename: string,
  content: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });

  const documentPath = join(dir, filename);
  await writeFile(documentPath, content, "utf8");

  return documentPath;
}

export async function readJsonStateArtifact(path: string): Promise<RunState> {
  try {
    const contents = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(contents);

    if (!isPlainObject(parsed)) {
      throw new Error("run state must be a JSON object");
    }

    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

/**
 * Serialize atomic writes per target path in-process. Concurrent writers of
 * one file (e.g. the scheduler persisting track.json from parallel branches)
 * must not race their replace-renames: Windows rejects overlapping renames of
 * a single target with EPERM. Writes to different paths still run fully
 * concurrently.
 */
const pendingAtomicWrites = new Map<string, Promise<void>>();

function enqueueAtomicWrite(path: string, task: () => Promise<void>): Promise<void> {
  const previous = pendingAtomicWrites.get(path) ?? Promise.resolve();
  // `previous` is always a settled-OK tail (or a fresh resolve), so a failed
  // predecessor can neither skip nor fail the next writer; each caller only
  // observes its own task result.
  const result = previous.then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  pendingAtomicWrites.set(path, tail);
  void tail.then(() => {
    if (pendingAtomicWrites.get(path) === tail) {
      pendingAtomicWrites.delete(path);
    }
  });
  return result;
}

/** Codes where a failed replace-rename may be transient (Windows antivirus
 * scans, a competing replace, or a reader holding the target open) and worth
 * a bounded retry. */
const retryableRenameCodes: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
/**
 * A replace-rename on Windows fails with EPERM while ANY other process has the
 * target open without FILE_SHARE_DELETE - including the runtime's own wait
 * poller reading the answer file, and the dashboard's event reader. The
 * handle is released as soon as that read completes, so the rename is worth
 * retrying for a while: a short budget turns a normal concurrent read into a
 * hard write failure.
 */
const renameMaxAttempts = 8;
const renameBaseBackoffMs = 20;
const renameMaxBackoffMs = 250;

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (
        attempt >= renameMaxAttempts ||
        !isNodeError(error) ||
        !retryableRenameCodes.has(error.code ?? "")
      ) {
        throw error;
      }
      const backoff = Math.min(renameBaseBackoffMs * attempt, renameMaxBackoffMs);
      await new Promise((resolve) => {
        setTimeout(resolve, backoff);
      });
    }
  }
}

/**
 * Persist JSON durably: write to a unique tmp file in the same directory, then
 * rename over the target so concurrent readers only ever observe the previous
 * complete file or the new complete file, never a partial write. On success no
 * `*.tmp` file is left behind; on failure the tmp file is removed. Concurrent
 * calls for the same target are serialized in-process, and transient rename
 * failures are retried briefly before giving up.
 */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await enqueueAtomicWrite(path, async () => {
    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await renameWithRetry(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function writeJsonStateArtifact(path: string, state: RunState): Promise<void> {
  await atomicWriteJson(path, state);
}

export function runStatePath(runDir: string): string {
  return join(runDir, "state.json");
}

export function globalStatePath(runDir: string): string {
  return join(runDir, "global-state.json");
}

export function branchStatePath(runDir: string, branchId: string): string {
  return join(runDir, "branches", `${branchId}.state.json`);
}

export async function readRunState(runDir: string): Promise<RunState> {
  return await readJsonStateArtifact(runStatePath(runDir));
}

export async function writeRunState(runDir: string, state: RunState): Promise<void> {
  await writeJsonStateArtifact(runStatePath(runDir), state);
}

export async function readGlobalState(runDir: string): Promise<RunState> {
  return await readJsonStateArtifact(globalStatePath(runDir));
}

export async function writeGlobalState(runDir: string, state: RunState): Promise<void> {
  await writeJsonStateArtifact(globalStatePath(runDir), state);
}

export async function readBranchRunState(runDir: string, branchId: string): Promise<RunState> {
  return await readJsonStateArtifact(branchStatePath(runDir, branchId));
}

export async function writeBranchRunState(
  runDir: string,
  branchId: string,
  state: RunState,
): Promise<void> {
  await writeJsonStateArtifact(branchStatePath(runDir, branchId), state);
}

function validateRunName(runName: string): void {
  if (
    runName.trim().length === 0 ||
    runName === "." ||
    runName === ".." ||
    runName.includes("/") ||
    runName.includes("\\")
  ) {
    throw new TrailStepFailureError({
      code: "run_name_invalid",
      message: "Run name must be a non-empty single path segment.",
      details: { runName },
    });
  }
}

async function ensureTrailStepGitignoreForRunsRoot(runsRoot: string): Promise<void> {
  const trailstepRoot = dirname(runsRoot);
  if (basename(trailstepRoot) !== TRAILSTEP_DIR_NAME) {
    return;
  }

  await ensureTrailStepGitignore(trailstepRoot);
}

async function ensureTrailStepGitignore(trailstepRoot: string): Promise<void> {
  try {
    await writeFile(join(trailstepRoot, ".gitignore"), "*\n!.gitignore\n", { flag: "wx" });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }

    throw error;
  }
}
