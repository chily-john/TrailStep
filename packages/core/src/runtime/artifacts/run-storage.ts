import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Event } from "../../contracts/events/event.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { errorMessage, isNodeError, isPlainObject } from "../../json/guards.js";
import { RUNS_ROOT_STAGING_DIR_NAME, validateRunIdentifier } from "../../runs/run-identifier.js";

export type { Event } from "../../contracts/events/event.types.js";
export {
  isReservedRunsRootEntry,
  RUNS_ROOT_STAGING_DIR_NAME,
} from "../../runs/run-identifier.js";

export type RunState = Record<string, unknown>;

/** Name of the per-project TrailStep state directory (e.g. `<cwd>/.trailstep`). */
export const TRAILSTEP_DIR_NAME = ".trailstep";

export function defaultRunsRoot(cwd: string): string {
  return join(cwd, TRAILSTEP_DIR_NAME, "runs");
}

/**
 * How old a staging directory must be before a later run creation removes it.
 * A live creation writes its track and renames within milliseconds, so one day
 * is unambiguously stale and can never race a healthy creator.
 */
export const STALE_RUN_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Prefix `mkdtemp` gives every staging directory this module creates. */
const RUN_STAGING_ENTRY_PREFIX = "run-";

/**
 * Creates a fresh run directory under the runs root.
 *
 * - `runName`: caller-chosen base name for the run (validated; defaults to the
 *   workflow id via callers). It is the first choice for the directory name.
 * - `runId`: the unique name actually used — `runName`, or `runName-<n>` when
 *   a previous run already took the base name (n increments until free).
 * - `runDir`: the absolute path of the new run directory
 *   (`<runsRoot>/<runId>`) where events.jsonl and other artifacts are written.
 * - `initialTrackState`: optional factory for the `track.json` a new run must
 *   own before its directory is returned to the caller. It runs only after a
 *   genuinely new directory is staged; a failure removes that staging directory
 *   and fails creation instead of leaving a run the classifier would call
 *   unknown. The staged directory is renamed into its final name only after the
 *   track is written, so the final path never exists without a readable track.
 *   After the rename the published track is re-read and must record this run
 *   id; otherwise the name belongs to a concurrent creator and creation moves
 *   to the next suffix instead of deleting a directory it cannot prove is its
 *   own.
 *
 * Staging lives in one reserved `<runsRoot>/.staging` directory whose child
 * names never embed the run name, so long-but-legal run names are limited only
 * by the final path. Each creation opportunistically removes only its own
 * `run-*` staging entries older than {@link STALE_RUN_STAGING_MAX_AGE_MS}, so a
 * crash cannot leave phantoms or leak empty staging directories forever.
 *
 * A directory at the staging path is not necessarily staging. Released versions
 * accepted a run named exactly `.staging`, so a real project can hold a legacy
 * run there. Such a run (its own `events.jsonl` and `track.json`) is never
 * pruned, and nothing inside it is reclaimed either: it is the `.staging`
 * directory itself, not an entry inside it, so its children are run content. It
 * stays out of run listings because `.staging` is a reserved runs-root entry; an
 * operator can still read it by explicit path through read-only inspection
 * (`access: "inspect"`), and that is deliberate. Moving or migrating the
 * directory would risk exactly the data loss this guard prevents, so it stays in
 * place until an operator relocates it.
 */
export async function createRunDirectory(options: {
  readonly cwd: string;
  readonly runName: string;
  readonly runsRoot?: string;
  readonly initialTrackState?: (created: {
    readonly runId: string;
    readonly runDir: string;
  }) => object | Promise<object>;
}): Promise<{ runId: string; runDir: string }> {
  const runsRoot = options.runsRoot ?? defaultRunsRoot(options.cwd);
  await validateRunIdentifier(options.runName, {
    cwd: options.cwd,
    runsRoot,
    access: "mutate",
    form: "name",
  });
  await mkdir(runsRoot, { recursive: true });
  await ensureTrailStepGitignoreForRunsRoot(runsRoot);
  // Opportunistic, best-effort cleanup: a failed prune must never fail a run.
  await pruneStaleRunStaging(runsRoot).catch(() => undefined);

  const stagingRoot = join(runsRoot, RUNS_ROOT_STAGING_DIR_NAME);
  await mkdir(stagingRoot, { recursive: true });

  for (let suffix = 1; ; suffix += 1) {
    const runId = suffix === 1 ? options.runName : `${options.runName}-${suffix}`;
    const runDir = join(runsRoot, runId);

    // Check before staging so an existing (even empty) run directory keeps its
    // name. A concurrent creator that wins after this check has a non-empty
    // directory with its track, so the rename below fails instead of replacing it.
    if (await pathExists(runDir)) {
      continue;
    }

    // Staging names deliberately omit the run name: a long but legal run name
    // must not push the staging path over the filesystem component limit.
    const tempDir = await createStagingDirectory(stagingRoot);
    try {
      if (options.initialTrackState !== undefined) {
        try {
          const initialTrack = await options.initialTrackState({ runId, runDir });
          // Validate the in-memory track before publishing: a track that does
          // not record this run id would make the final directory claim another
          // owner. This check is before the write so a caller bug leaves no
          // directory behind.
          const recordedRunId = isPlainObject(initialTrack) ? initialTrack.runId : undefined;
          if (recordedRunId !== runId) {
            throw new TrailStepFailureError({
              code: "run_track_initialization_failed",
              message: `Initial track metadata for new run ${runId} must record runId ${runId}.`,
              details: { runDir, recordedRunId },
            });
          }
          await atomicWriteJson(join(tempDir, "track.json"), initialTrack);
        } catch (error) {
          throw new TrailStepFailureError({
            code: "run_track_initialization_failed",
            message: `Failed to initialize track metadata for new run ${runId}: ${errorMessage(error)}`,
            details: { runDir, ...(isNodeError(error) ? { causeCode: error.code } : {}) },
          });
        }
      }

      try {
        // Production creations always staged a track.json above, so this source
        // directory is non-empty: on POSIX, rename replaces only an empty target,
        // and a concurrent creator's track-bearing directory fails instead.
        // A caller that passed no initialTrackState leaves an empty source; it
        // may replace an empty target, which is not a readable run yet.
        await rename(tempDir, runDir);
      } catch (error) {
        // Never treat an occupied final name as ours: discard the staged copy
        // and try the next suffix, preserving the -2, -3, ... collision
        // behaviour. Both errno values are real cross-platform collisions.
        if (
          (await pathExists(runDir)) ||
          (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY"))
        ) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        throw error;
      }

      const publishedRunId = await readTrackRunId(runDir);
      // A track-bearing creation must publish its own track; a track-less
      // creation must not inherit a foreign one. Either way, never delete a
      // directory whose track we cannot prove is ours: leave it to its owner
      // and take the next suffix.
      //
      // A foreign track here is unreachable in practice for a track-bearing
      // creation: the staged source contains track.json and a non-empty source
      // can only be renamed onto an empty target, so a foreign track-bearing
      // target makes the rename above fail with ENOTEMPTY/EEXIST instead. Only
      // a synthetic fixture (or a track-less creation racing a foreign track
      // writer) can produce this state. Do not add a reclaim path for it: the
      // contested directory stays visible to every run enumerator under its
      // own name, and deleting it would destroy evidence owned by another run.
      // The ownership check remains as a defensive guard against races and
      // non-POSIX rename semantics.
      const ownsPublishedTrack =
        options.initialTrackState === undefined
          ? publishedRunId === undefined || publishedRunId === runId
          : publishedRunId === runId;
      if (!ownsPublishedTrack) {
        await removeStagingRootIfEmpty(stagingRoot);
        continue;
      }

      await removeStagingRootIfEmpty(stagingRoot);
      return { runId, runDir };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      await removeStagingRootIfEmpty(stagingRoot);
      throw error;
    }
  }
}

async function removeStagingRootIfEmpty(stagingRoot: string): Promise<void> {
  try {
    await rmdir(stagingRoot);
  } catch {
    // Another creation is still staging, or the directory is already gone.
  }
}

async function createStagingDirectory(stagingRoot: string): Promise<string> {
  // A concurrent creation may remove an empty `.staging` between our mkdir and
  // mkdtemp. Recreate it once instead of failing a healthy run.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await mkdtemp(join(stagingRoot, RUN_STAGING_ENTRY_PREFIX));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT" || attempt > 0) {
        throw error;
      }
      await mkdir(stagingRoot, { recursive: true });
    }
  }
}

/**
 * Whether a `.staging` child is a directory this module created. Anything else
 * under the staging directory is not ours to delete: a released version allowed
 * a run named `.staging`, so legacy run content can live there.
 */
function isRunStagingEntryName(name: string): boolean {
  return name.startsWith(RUN_STAGING_ENTRY_PREFIX);
}

/**
 * Defence in depth for reclamation: even a `run-*` name is not enough to
 * delete an entry that holds run artifacts, so a future naming change cannot
 * turn a misidentified run into a deletion target. The cost is that a staging
 * directory abandoned after its track write is left in place (it is small and
 * invisible to run listings). An I/O error also counts as "not safely
 * removable" and leaves the entry alone.
 */
async function holdsRunArtifacts(dir: string): Promise<boolean> {
  for (const artifact of ["events.jsonl", "track.json"] as const) {
    try {
      await lstat(join(dir, artifact));
      return true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return false;
}

/**
 * Reclaims stale `run-*` staging entries left by crashed creations.
 *
 * Reclamation is suspended while `<runsRoot>/.staging` is itself a legacy run:
 * `holdsRunArtifacts` returns early so nothing inside a real run is deleted. The
 * cost is that abandoned `run-*` staging entries in that project are never
 * reclaimed and accumulate for as long as the legacy run stays there. There is
 * no automatic migration. Manual remedy: after stopping any process using the
 * run, an operator can move the legacy run directory to a normal (non-reserved)
 * name under the runs root, which preserves it and makes it visible to run
 * listings; reclamation resumes on the next creation.
 */
async function pruneStaleRunStaging(runsRoot: string): Promise<void> {
  const cutoffMs = Date.now() - STALE_RUN_STAGING_MAX_AGE_MS;
  const dir = join(runsRoot, RUNS_ROOT_STAGING_DIR_NAME);
  // A released version allowed a run named exactly `.staging`, so the staging
  // path can itself be a legacy run. Its children are run content, not staging
  // entries, so reclamation must not touch anything inside it.
  if (await holdsRunArtifacts(dir)) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    // Never delete anything under `.staging` that this module did not create.
    if (!isRunStagingEntryName(entry.name)) {
      continue;
    }

    const entryPath = join(dir, entry.name);
    try {
      const info = await lstat(entryPath);
      if (!info.isDirectory() || info.mtimeMs > cutoffMs) {
        continue;
      }
      if (await holdsRunArtifacts(entryPath)) {
        continue;
      }
      await rm(entryPath, { recursive: true, force: true });
    } catch {
      // A concurrent creator may publish or remove the entry between readdir
      // and lstat; cleanup stays best-effort and must never fail a run.
    }
  }
}

/**
 * Serialize appends per events file in-process. Parallel branches, the agent heartbeat and
 * the CLI cancel command all append to one `events.jsonl`; unserialized `appendFile` calls
 * can interleave and produce a torn line. Writes to different runs still run concurrently.
 */
const pendingAppends = new Map<string, Promise<void>>();

function enqueueAppend(path: string, task: () => Promise<void>): Promise<void> {
  const previous = pendingAppends.get(path) ?? Promise.resolve();
  const result = previous.then(task, task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  pendingAppends.set(path, tail);
  void tail.then(() => {
    if (pendingAppends.get(path) === tail) {
      pendingAppends.delete(path);
    }
  });
  return result;
}

export async function appendEvent(runDir: string, event: Event): Promise<void> {
  const eventsPath = join(runDir, "events.jsonl");
  await enqueueAppend(eventsPath, async () => {
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  });
}

/**
 * Reads a run's whole `events.jsonl` trail for recovery (resume/continue/retry).
 * Malformed or non-event-shaped lines are reported through `options.report` and
 * skipped: a torn line from a crash mid-append must never invalidate the rest
 * of the trail.
 */
export async function readRunEvents(
  runDir: string,
  options: { readonly report?: (message: string) => void } = {},
): Promise<Event[]> {
  const eventsPath = join(runDir, "events.jsonl");
  let contents: string;
  try {
    contents = await readFile(eventsPath, "utf8");
  } catch (error) {
    if (isNodeError(error)) {
      throw new TrailStepFailureError({
        code: "resume_target_not_found",
        message: `Resume target not found or unreadable: ${eventsPath}.`,
        details: { runDir, causeCode: error.code },
      });
    }

    throw error;
  }

  const rawLines = contents.split("\n");
  const lines = rawLines.filter((line, index) => line.length > 0 || index < rawLines.length - 1);
  const events: Event[] = [];

  const report = options.report ?? (() => undefined);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn line (crash or power loss mid-append) must never invalidate the rest of the
      // trail. Recovery paths replay this file; refusing to read it turns a recoverable
      // run into a permanently bricked one. Skip and keep going.
      report(`Unable to parse event JSONL in ${eventsPath}: line ${index + 1}. Skipping line.`);
      continue;
    }

    if (!isEventLike(parsed)) {
      report(`Unexpected event shape in ${eventsPath}: line ${index + 1}. Skipping line.`);
      continue;
    }

    events.push(parsed);
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
  /**
   * Full file text, or `""` when the trail has not grown since `startCursor` (the no-new-bytes
   * short-circuit). Callers that need the whole trail must parse it from the run directory
   * instead of relying on this field.
   */
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
  const { size } = await stat(eventsFile);
  if (size < startCursor) {
    // The file shrank (truncated or recreated): restart from the beginning.
    return readRunEventsSince(eventsFile, 0, options);
  }
  if (size === startCursor) {
    // Nothing new. The caller long-polls every 50 ms; reading and decoding the whole trail on
    // every poll makes watch O(file size) per poll and it falls permanently behind on long runs.
    return { text: "", offset: startCursor, entries: [] };
  }

  const buffer = await readFile(eventsFile);
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** The run id recorded by a published `track.json`, or undefined when unreadable. */
async function readTrackRunId(runDir: string): Promise<string | undefined> {
  try {
    const track = JSON.parse(await readFile(join(runDir, "track.json"), "utf8")) as unknown;
    return isPlainObject(track) && typeof track.runId === "string" ? track.runId : undefined;
  } catch {
    return undefined;
  }
}

async function ensureTrailStepGitignoreForRunsRoot(runsRoot: string): Promise<void> {
  const trailstepRoot = dirname(runsRoot);
  if (basename(trailstepRoot) !== TRAILSTEP_DIR_NAME) {
    return;
  }

  await ensureTrailStepGitignore(trailstepRoot);
}

/**
 * Run artifacts and machine-local config are not source. `.trailstep/config.json` IS source:
 * it holds the team-shared agent and workflow configuration, so it must stay committable.
 * (The previous blanket `*` ignored it, which silently dropped project config from commits.)
 */
export const TRAILSTEP_GITIGNORE_BODY = [
  "# Generated by TrailStep. Run artifacts and machine-local config are not source.",
  "# .trailstep/config.json IS meant to be committed; do not ignore it.",
  "runs/",
  ".archive/",
  "sessions/",
  "worktrees/",
  "tmp/",
  "inputs/",
  "mcp/",
  "config-local.json",
  "run.lock",
  "*.tmp",
  "",
].join("\n");

/** The blanket-ignore body older versions wrote. Replaced in place when found verbatim. */
const LEGACY_TRAILSTEP_GITIGNORE_BODY = "*\n!.gitignore\n";

async function ensureTrailStepGitignore(trailstepRoot: string): Promise<void> {
  const gitignorePath = join(trailstepRoot, ".gitignore");

  let existing: string | undefined;
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  if (existing === undefined) {
    try {
      await writeFile(gitignorePath, TRAILSTEP_GITIGNORE_BODY, { flag: "wx" });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    return;
  }

  // Repair only the exact legacy generated body. A hand-edited .gitignore is the user's and
  // must never be rewritten.
  if (existing === LEGACY_TRAILSTEP_GITIGNORE_BODY) {
    await writeFile(gitignorePath, TRAILSTEP_GITIGNORE_BODY, "utf8");
  }
}
