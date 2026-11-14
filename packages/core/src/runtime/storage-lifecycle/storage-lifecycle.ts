/**
 * Storage lifecycle: archive, restore, pin and delete run artifacts.
 *
 * Automatic archive/delete is fail-closed: eligibility comes from
 * `assessStorageEligibility`, an explicit assessment over a strict event read,
 * track readability, pin state and strict lock ownership. A run summary's
 * display status is never the safety authority, and an eventless terminal
 * track is not terminal proof (D-LOCK-2).
 *
 * Direct name-addressed operations and lifecycle actions share the canonical
 * run-identifier validator in `runs/run-identifier.ts`, so a run id cannot
 * alias the runs root, its parent, or `.staging`/`.archive`.
 *
 * Two liveness limitations are deliberate and documented at their checks:
 *
 * - **Time-of-check/time-of-use (TOCTOU).** The lock is read in the planner and
 *   again in `assertRunNotLiveLocked`, but neither read is atomic with the
 *   directory rename/removal. A process can acquire the lock after the check
 *   and before the mutation, so a just-started run may still be archived or
 *   deleted. A future fix would hold an exclusive lifecycle lock that outlives
 *   the rename, or make the mutation a compare-and-swap directory rename.
 * - **Reused-pid stale lock.** Lock liveness is pid-only. If a run's process
 *   died and the operating system reused its pid for an unrelated live
 *   process, the stale `run.lock` looks live and archive/delete is blocked
 *   forever. There is intentionally no stale-lock escape in this story; a
 *   future fix would check process start time or a boot identifier, or offer an
 *   explicit operator-approved escape.
 */
import { createReadStream, type Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { Event } from "../../contracts/events/event.types.js";
import { isNodeError, isPlainObject } from "../../json/guards.js";
import { validateRunIdentifier } from "../../runs/run-identifier.js";
import { defaultRunsRoot } from "../artifacts/run-storage.js";
import {
  findLifecycleTerminalEvent,
  type LifecycleTerminalState,
  selectCurrentLifecycleCycle,
} from "../events/lifecycle-cycle.js";
import { readBoundedTextFile } from "../evidence/bounded-readers.js";
import { readTrackStateSignal } from "../evidence/classify-run-state.js";
import {
  observeRunLock,
  type RunLockObservation,
  type RunLockOwnerState,
} from "../run-lock/run-lock.js";
import { listRunSummaries } from "../runs/run-summaries.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface StorageLifecyclePolicy {
  readonly enabled?: boolean;
  readonly archiveAfterDays?: number | false;
  readonly deleteAfterDays?: number | false;
  readonly workflows?: Readonly<
    Record<
      string,
      { readonly archiveAfterDays?: number | false; readonly deleteAfterDays?: number | false }
    >
  >;
}

export interface StorageLifecycleAction {
  readonly action: "archive" | "delete-hot" | "delete-archive";
  readonly runId: string;
  readonly reason: string;
  readonly path: string;
}

export interface StorageLifecycleStatus {
  readonly runsRoot: string;
  readonly enabled: boolean;
  readonly hotRuns: number;
  readonly archivedRuns: number;
  readonly pinnedRuns: readonly string[];
}

interface ArchiveManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly archivedAt: string;
  readonly sourceRunDir: string;
  readonly workflowId?: string;
  readonly lastTimestamp?: string;
  readonly status?: string;
  readonly pinned?: boolean;
}

interface ArchivePayload {
  readonly manifest: ArchiveManifest;
  readonly files: readonly { readonly path: string; readonly contentBase64: string }[];
}

/**
 * A storage-eligibility read is deliberately bounded. A trail larger than this
 * budget is preserved instead of being automatically archived or deleted. D4
 * prefers a missed cleanup over a destructive action under unread evidence.
 */
const STORAGE_EVENTS_MAX_BYTES = 64 * 1024 * 1024;
const STORAGE_TRACK_MAX_BYTES = 256 * 1024;

export type StorageEventReadStatus =
  | "complete"
  | "missing"
  | "partial"
  | "malformed"
  | "unreadable"
  | "aborted";

export type StorageTrackObservation = "missing" | "readable" | "unreadable";

export type StorageLockObservation = "missing" | RunLockOwnerState | "malformed" | "unreadable";

export type StorageEligibilityCode =
  | "eligible"
  | "events-missing"
  | "events-partial"
  | "events-malformed"
  | "events-unreadable"
  | "events-aborted"
  | "eventless-terminal-track"
  | "terminal-missing"
  | "track-missing"
  | "track-unreadable"
  | "pinned"
  | "pin-unreadable"
  | "lock-live"
  | "lock-owner-unknown"
  | "lock-malformed"
  | "lock-unreadable";

/**
 * Result of the storage mutation gate. `eligible` is true only when a
 * current-cycle terminal event, a readable track, an unpinned run and safety
 * proof for ownership all hold. `eventRead`, `track` and `lock` keep absent
 * evidence distinct from unreadable/ambiguous evidence for diagnostics.
 */
export interface StorageEligibilityAssessment {
  readonly eligible: boolean;
  readonly code: StorageEligibilityCode;
  readonly message: string;
  readonly eventRead: StorageEventReadStatus;
  readonly track: StorageTrackObservation;
  readonly lock: StorageLockObservation;
  readonly terminalState?: LifecycleTerminalState;
  readonly terminalEvent?: Event;
  readonly workflowId?: string;
  readonly lastTimestamp?: string;
}

interface StorageEventRead {
  readonly status: StorageEventReadStatus;
  readonly events: readonly Event[];
  readonly message?: string;
}

export function storageArchiveDir(runsRoot: string): string {
  return join(runsRoot, ".archive");
}

export function storagePinPath(runDir: string): string {
  return join(runDir, ".trailstep-pin.json");
}

export async function readStorageLifecycleStatus(options: {
  readonly cwd: string;
  readonly runsRoot?: string;
  readonly policy?: StorageLifecyclePolicy;
}): Promise<StorageLifecycleStatus> {
  const runsRoot = options.runsRoot ?? defaultRunsRoot(options.cwd);
  const [runSummaries, archivedRuns, pinnedRuns] = await Promise.all([
    listRunSummaries({ cwd: options.cwd, runsRoot }),
    listArchivedRunIds(runsRoot),
    listPinnedRunIds({ cwd: options.cwd, runsRoot }),
  ]);
  const hotRuns = runSummaries.filter((summary) => summary.status !== "archived");
  return {
    runsRoot,
    enabled: options.policy?.enabled === true,
    hotRuns: hotRuns.length,
    archivedRuns: archivedRuns.length,
    pinnedRuns,
  };
}

export async function planStorageLifecycle(options: {
  readonly cwd: string;
  readonly runsRoot?: string;
  readonly policy?: StorageLifecyclePolicy;
  readonly now?: Date;
}): Promise<StorageLifecycleAction[]> {
  const policy = options.policy;
  if (policy?.enabled !== true) {
    return [];
  }

  const runsRoot = options.runsRoot ?? defaultRunsRoot(options.cwd);
  const now = options.now ?? new Date();
  const summaries = await listRunSummaries({ cwd: options.cwd, runsRoot });
  const actions: StorageLifecycleAction[] = [];

  for (const summary of summaries) {
    // Archived entries have no hot run directory to assess.
    if (summary.status === "archived") {
      continue;
    }

    // The summary only supplies the run location, workflow id and age. Its
    // status is a display projection and must not authorize mutation.
    //
    // Known limitation (TOCTOU): this assessment is not atomic with the later
    // archive/delete mutation. A process can acquire the lock after this check
    // and before `archiveRun`/`deleteRun` renames or removes the directory, so
    // a just-started run may still be archived or deleted. A future fix (D5)
    // would hold an exclusive lifecycle lock across the mutation, or make the
    // mutation a compare-and-swap directory rename.
    //
    // Known limitation (reused pid): liveness is pid-only, so a stale lock
    // whose pid was recycled by an unrelated live process keeps this run out
    // of the plan forever. There is intentionally no stale-lock escape here;
    // see `assertRunOwnershipProvedAbsent` for the same limitation on direct
    // calls.
    const assessment = await assessStorageEligibility({ runDir: summary.runDir });
    if (!assessment.eligible) {
      continue;
    }

    const workflowPolicy = summary.workflowId ? policy.workflows?.[summary.workflowId] : undefined;
    const archiveAfterDays = resolvePolicyDays(workflowPolicy, policy, "archiveAfterDays");
    const deleteAfterDays = resolvePolicyDays(workflowPolicy, policy, "deleteAfterDays");
    const ageDays = ageInDays(summary.lastTimestamp, now);
    if (ageDays === undefined) {
      continue;
    }

    if (deleteAfterDays !== undefined && ageDays >= deleteAfterDays) {
      actions.push({
        action: "delete-hot",
        runId: summary.runId,
        path: summary.runDir,
        reason: `${assessment.terminalState ?? "terminal"} run is ${Math.floor(ageDays)}d old (deleteAfterDays=${deleteAfterDays})`,
      });
    } else if (archiveAfterDays !== undefined && ageDays >= archiveAfterDays) {
      actions.push({
        action: "archive",
        runId: summary.runId,
        path: summary.runDir,
        reason: `${assessment.terminalState ?? "terminal"} run is ${Math.floor(ageDays)}d old (archiveAfterDays=${archiveAfterDays})`,
      });
    }
  }

  for (const manifest of await readArchiveManifests(runsRoot)) {
    const workflowPolicy = manifest.workflowId
      ? policy.workflows?.[manifest.workflowId]
      : undefined;
    const deleteAfterDays = resolvePolicyDays(workflowPolicy, policy, "deleteAfterDays");
    const ageDays = ageInDays(manifest.lastTimestamp, now);
    if (manifest.pinned === true || deleteAfterDays === undefined || ageDays === undefined) {
      continue;
    }
    if (ageDays >= deleteAfterDays) {
      actions.push({
        action: "delete-archive",
        runId: manifest.runId,
        path: archivePayloadPath(runsRoot, manifest.runId),
        reason: `archived run is ${Math.floor(ageDays)}d old (deleteAfterDays=${deleteAfterDays})`,
      });
    }
  }

  return actions;
}

export async function applyStorageLifecycle(options: {
  readonly cwd: string;
  readonly runsRoot?: string;
  readonly policy?: StorageLifecyclePolicy;
  readonly now?: Date;
  readonly dryRun?: boolean;
}): Promise<StorageLifecycleAction[]> {
  const actions = await planStorageLifecycle(options);
  if (options.dryRun === true) {
    return actions;
  }
  const runsRoot = options.runsRoot ?? defaultRunsRoot(options.cwd);
  for (const action of actions) {
    if (action.action === "archive") {
      await archiveRun({ runsRoot, runId: action.runId, now: options.now });
    } else if (action.action === "delete-hot") {
      await deleteEligibleHotRun({ runsRoot, runId: action.runId });
    } else {
      await deleteArchivedRun({ runsRoot, runId: action.runId });
    }
  }
  return actions;
}

export async function archiveRun(options: {
  readonly runsRoot: string;
  readonly runId: string;
  readonly now?: Date;
  /** Test seam for failure injection; production uses `readDirectoryPayload`. */
  readonly readPayload?: (
    runDir: string,
  ) => Promise<readonly { readonly path: string; readonly contentBase64: string }[]>;
}): Promise<void> {
  const runDir = await validateStorageRunId(options.runsRoot, options.runId);
  const assessment = await assessStorageEligibility({ runDir });
  if (!assessment.eligible) {
    throw archiveIneligibilityError(options.runId, assessment, "not");
  }

  const files = await (options.readPayload ?? readDirectoryPayload)(runDir);

  // Revalidate immediately before the protective write/removal transition.
  // This narrows the window but does NOT solve TOCTOU; D5 owns atomic
  // exclusion between execution acquisition and destructive transitions.
  const boundaryAssessment = await assessStorageEligibility({ runDir });
  if (!boundaryAssessment.eligible) {
    throw archiveIneligibilityError(options.runId, boundaryAssessment, "no longer");
  }

  const manifest: ArchiveManifest = {
    schemaVersion: 1,
    runId: options.runId,
    archivedAt: (options.now ?? new Date()).toISOString(),
    sourceRunDir: runDir,
    ...(boundaryAssessment.workflowId === undefined
      ? {}
      : { workflowId: boundaryAssessment.workflowId }),
    ...(boundaryAssessment.lastTimestamp === undefined
      ? {}
      : { lastTimestamp: boundaryAssessment.lastTimestamp }),
    ...(boundaryAssessment.terminalState === undefined
      ? {}
      : { status: boundaryAssessment.terminalState }),
  };
  const payload: ArchivePayload = { manifest, files };
  await mkdir(storageArchiveDir(options.runsRoot), { recursive: true });
  await writeFile(
    archivePayloadPath(options.runsRoot, options.runId),
    await gzipAsync(JSON.stringify(payload)),
    "utf8",
  );
  await writeFile(
    archiveManifestPath(options.runsRoot, options.runId),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await rm(runDir, { recursive: true, force: true });
}

/**
 * Restores an archived run's historical files without creating a new run
 * track. This is an intentional exception to the creation invariant that a
 * new run directory always owns a track: a restored run is historical, so a
 * legacy archive without `track.json` must stay classifiable as unknown
 * instead of being given a synthetic current track.
 */
export async function restoreArchivedRun(options: {
  readonly runsRoot: string;
  readonly runId: string;
}): Promise<void> {
  const runDir = await validateStorageRunId(options.runsRoot, options.runId);
  const payloadPath = archivePayloadPath(options.runsRoot, options.runId);
  const manifestPath = archiveManifestPath(options.runsRoot, options.runId);
  if (await pathExists(runDir)) {
    throw new Error(
      `Run ${options.runId} already exists in hot storage; refusing to overwrite it.`,
    );
  }
  const payload = JSON.parse(
    String(await gunzipAsync(await readFile(payloadPath))),
  ) as ArchivePayload;
  await mkdir(runDir, { recursive: true });
  for (const file of payload.files) {
    const target = join(runDir, file.path);
    if (!relative(runDir, target) || relative(runDir, target).startsWith("..")) {
      throw new Error(`Archive for ${options.runId} contains an invalid path.`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, "base64"));
  }
  await rm(payloadPath, { force: true });
  await rm(manifestPath, { force: true });
}

export async function pinRun(options: {
  readonly runsRoot: string;
  readonly runId: string;
}): Promise<void> {
  const runDir = await validateStorageRunId(options.runsRoot, options.runId);
  if (!(await pathExists(runDir))) {
    if (await pathExists(archiveManifestPath(options.runsRoot, options.runId))) {
      throw new Error(`Run ${options.runId} is archived; restore it before pinning.`);
    }
    throw new Error(`Run ${options.runId} does not exist.`);
  }
  await writeFile(
    storagePinPath(runDir),
    `${JSON.stringify({ schemaVersion: 1, pinnedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

export async function unpinRun(options: {
  readonly runsRoot: string;
  readonly runId: string;
}): Promise<void> {
  const runDir = await validateStorageRunId(options.runsRoot, options.runId);
  if (!(await pathExists(runDir))) {
    if (await pathExists(archiveManifestPath(options.runsRoot, options.runId))) {
      throw new Error(`Run ${options.runId} is archived; restore it before unpinning.`);
    }
    throw new Error(`Run ${options.runId} does not exist.`);
  }
  await rm(storagePinPath(runDir), { force: true });
}

export async function deleteRun(options: {
  readonly runsRoot: string;
  readonly runId: string;
}): Promise<void> {
  const runDir = await validateStorageRunId(options.runsRoot, options.runId);
  if (await pathExists(runDir)) {
    // Explicit deletion is an operator action, so a non-terminal run is allowed.
    // Ownership must still be proved safe: a live, malformed, unreadable or
    // unassessable lock is never treated as absence.
    await assertRunOwnershipProvedAbsent(runDir, options.runId, "deleted");
    const pinState = await readStoragePinState(runDir);
    if (pinState === "pinned") {
      throw new Error(`Run ${options.runId} is pinned and cannot be deleted.`);
    }
    if (pinState === "unreadable") {
      throw new Error(`Run ${options.runId} has an unreadable pin marker and cannot be deleted.`);
    }
    await rm(runDir, { recursive: true, force: true });
    return;
  }
  const manifest = await readArchiveManifest(options.runsRoot, options.runId);
  if (manifest === undefined) {
    throw new Error(`Run ${options.runId} does not exist.`);
  }
  if (manifest.pinned === true) {
    throw new Error(`Run ${options.runId} is pinned and cannot be deleted.`);
  }
  await deleteArchivedRun(options);
}

export async function deleteArchivedRun(options: {
  readonly runsRoot: string;
  readonly runId: string;
}): Promise<void> {
  await validateStorageRunId(options.runsRoot, options.runId);
  await rm(archivePayloadPath(options.runsRoot, options.runId), { force: true });
  await rm(archiveManifestPath(options.runsRoot, options.runId), { force: true });
}

async function readDirectoryPayload(root: string): Promise<ArchivePayload["files"]> {
  const files: { path: string; contentBase64: string }[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push({
          path: normalizeArchivePath(relative(root, entryPath)),
          contentBase64: await streamFileBase64(entryPath),
        });
      }
    }
  }
  await visit(root);
  return files;
}

function normalizeArchivePath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function streamFileBase64(path: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("base64");
}

async function listPinnedRunIds(options: {
  readonly cwd: string;
  readonly runsRoot: string;
}): Promise<string[]> {
  const summaries = (await listRunSummaries(options)).filter(
    (summary) => summary.status !== "archived",
  );
  const pinned: string[] = [];
  for (const summary of summaries) {
    if (await isRunPinned(summary.runDir)) {
      pinned.push(summary.runId);
    }
  }
  return pinned.sort();
}

async function isRunPinned(runDir: string): Promise<boolean> {
  const state = await readStoragePinState(runDir);
  if (state === "unreadable") {
    throw new Error(`Could not read the pin marker at ${storagePinPath(runDir)}.`);
  }
  return state === "pinned";
}

async function readStoragePinState(runDir: string): Promise<"absent" | "pinned" | "unreadable"> {
  try {
    await stat(storagePinPath(runDir));
    return "pinned";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "absent";
    }
    return "unreadable";
  }
}

async function listArchivedRunIds(runsRoot: string): Promise<string[]> {
  return (await readArchiveManifests(runsRoot)).map((manifest) => manifest.runId).sort();
}

async function readArchiveManifest(
  runsRoot: string,
  runId: string,
): Promise<ArchiveManifest | undefined> {
  try {
    return JSON.parse(
      await readFile(archiveManifestPath(runsRoot, runId), "utf8"),
    ) as ArchiveManifest;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readArchiveManifests(runsRoot: string): Promise<ArchiveManifest[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(storageArchiveDir(runsRoot), { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const manifests: ArchiveManifest[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".manifest.json")) {
      continue;
    }
    manifests.push(
      JSON.parse(
        await readFile(join(storageArchiveDir(runsRoot), entry.name), "utf8"),
      ) as ArchiveManifest,
    );
  }
  return manifests;
}

function archivePayloadPath(runsRoot: string, runId: string): string {
  return join(storageArchiveDir(runsRoot), `${runId}.json.gz`);
}

function archiveManifestPath(runsRoot: string, runId: string): string {
  return join(storageArchiveDir(runsRoot), `${runId}.manifest.json`);
}

/**
 * Explicitly assess whether a hot run may be automatically archived/deleted.
 *
 * A current-cycle terminal workflow event is the lifecycle proof. D4 then adds
 * conservative mutation-gate checks: the event trail must have been read
 * strictly and completely, the track must be present and readable, the run
 * must be unpinned, and ownership must be proved absent. The track is required
 * for this gate only; it is not lifecycle truth, and a terminal event plus an
 * unreadable track stays preserved until D6 defines a recovery protocol.
 *
 * Absent evidence is reported distinctly from unreadable/ambiguous evidence.
 * Callers must not treat any ineligible result as terminal or recoverable.
 */
export async function assessStorageEligibility(options: {
  readonly runDir: string;
  readonly signal?: AbortSignal;
}): Promise<StorageEligibilityAssessment> {
  const readOptions = options.signal === undefined ? {} : { signal: options.signal };
  const [eventRead, trackSignal, pinState, lockObservation] = await Promise.all([
    readStorageEvents(options.runDir, options.signal),
    readTrackStateSignal(options.runDir, {
      maxBytes: STORAGE_TRACK_MAX_BYTES,
      ...readOptions,
    }),
    readStoragePinState(options.runDir),
    observeRunLock(options.runDir),
  ]);

  const track: StorageTrackObservation =
    trackSignal.present === false ? "missing" : trackSignal.readable ? "readable" : "unreadable";
  const lock = projectLockObservation(lockObservation);
  const terminal =
    eventRead.status === "complete"
      ? findLifecycleTerminalEvent(selectCurrentLifecycleCycle(eventRead.events))
      : undefined;
  const lastEvent = eventRead.events.at(-1);
  const workflowId = terminal?.event.workflowId ?? lastEvent?.workflowId;
  const eventlessTerminalTrack =
    (eventRead.status === "missing" ||
      (eventRead.status === "complete" && eventRead.events.length === 0)) &&
    track === "readable" &&
    isTerminalTrackState(trackSignal.status);

  const base = {
    eventRead: eventRead.status,
    track,
    lock,
    ...(terminal === undefined
      ? {}
      : { terminalState: terminal.state, terminalEvent: terminal.event }),
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(lastEvent?.timestamp === undefined ? {} : { lastTimestamp: lastEvent.timestamp }),
  } as const;
  const ineligible = (
    code: StorageEligibilityCode,
    message: string,
  ): StorageEligibilityAssessment => ({ ...base, eligible: false, code, message });

  if (eventlessTerminalTrack) {
    return ineligible(
      "eventless-terminal-track",
      "A terminal track without a current-cycle terminal workflow event is not storage proof (D-LOCK-2).",
    );
  }

  switch (eventRead.status) {
    case "aborted":
      return ineligible(
        "events-aborted",
        eventRead.message ?? "The event trail read was aborted, so eligibility is unknown.",
      );
    case "missing":
      return ineligible(
        "events-missing",
        "The event trail is missing, so no current-cycle terminal event can be proved.",
      );
    case "partial":
      return ineligible(
        "events-partial",
        eventRead.message ?? "The event trail was not read completely.",
      );
    case "malformed":
      return ineligible(
        "events-malformed",
        eventRead.message ?? "The event trail contains malformed data.",
      );
    case "unreadable":
      return ineligible(
        "events-unreadable",
        eventRead.message ?? "The event trail could not be read.",
      );
    case "complete":
      break;
  }

  if (terminal === undefined) {
    return ineligible(
      "terminal-missing",
      "No current-cycle terminal workflow event was found. A parked failure, wait, cancellation request, reopened cycle or terminal track alone is not terminal proof.",
    );
  }

  if (track === "missing") {
    return ineligible(
      "track-missing",
      "The run track is missing, so this conservative D4 mutation gate cannot prove eligibility.",
    );
  }
  if (track === "unreadable") {
    return ineligible(
      "track-unreadable",
      "The run track is present but unreadable, so storage cannot prove eligibility.",
    );
  }

  if (pinState === "pinned") {
    return ineligible("pinned", "The run is pinned.");
  }
  if (pinState === "unreadable") {
    return ineligible("pin-unreadable", "The pin marker could not be read.");
  }

  switch (lockObservation.status) {
    case "missing":
      return {
        ...base,
        eligible: true,
        code: "eligible",
        message:
          "Current-cycle terminal event, readable track, unpinned run and proved-absent ownership.",
      };
    case "observed":
      if (lockObservation.owner === "dead") {
        return {
          ...base,
          eligible: true,
          code: "eligible",
          message:
            "Current-cycle terminal event, readable track, unpinned run and a dead lock owner (pid-only proof).",
        };
      }
      if (lockObservation.owner === "live") {
        return ineligible("lock-live", "A live process holds the run lock.");
      }
      return ineligible(
        "lock-owner-unknown",
        "The run lock has an unassessable owner, so ownership is not proved absent.",
      );
    case "malformed":
      return ineligible("lock-malformed", lockObservation.message);
    case "unreadable":
      return ineligible("lock-unreadable", lockObservation.message);
  }
}

/**
 * Refuse to mutate a run whose owner is not proved absent. Used by explicit
 * operator deletion, which may target non-terminal runs but must not guess
 * ownership from malformed/unreadable lock data.
 *
 * Known limitation (TOCTOU): the lock observation and the caller's subsequent
 * rename or removal are not one atomic operation. D5 owns that protocol.
 *
 * Known limitation (reused pid): liveness is pid-only, so a stale `run.lock`
 * whose pid was recycled by an unrelated live process blocks mutation forever.
 * D7b owns stronger process-start identity.
 */
async function assertRunOwnershipProvedAbsent(
  runDir: string,
  runId: string,
  action: "archived" | "deleted",
): Promise<void> {
  const observation = await observeRunLock(runDir);
  switch (observation.status) {
    case "missing":
      return;
    case "observed":
      if (observation.owner === "dead") {
        return;
      }
      if (observation.owner === "live") {
        throw new Error(`Run ${runId} is held by a live process and cannot be ${action}.`);
      }
      throw new Error(`Run ${runId} has an unassessable lock owner and cannot be ${action}.`);
    case "malformed":
      throw new Error(`Run ${runId} has a malformed run.lock and cannot be ${action}.`);
    case "unreadable":
      throw new Error(`Run ${runId} has an unreadable run.lock and cannot be ${action}.`);
  }
}

/** Automatic delete-hot must prove the same positive eligibility as archive. */
async function deleteEligibleHotRun(options: {
  readonly runsRoot: string;
  readonly runId: string;
}): Promise<void> {
  const runDir = await validateStorageRunId(options.runsRoot, options.runId);
  const assessment = await assessStorageEligibility({ runDir });
  if (!assessment.eligible) {
    throw new Error(
      `Run ${options.runId} is no longer storage-eligible and cannot be deleted by gc: ${assessment.message}`,
    );
  }
  await rm(runDir, { recursive: true, force: true });
}

function archiveIneligibilityError(
  runId: string,
  assessment: StorageEligibilityAssessment,
  qualifier: "not" | "no longer",
): Error {
  if (assessment.code === "lock-live") {
    return new Error(`Run ${runId} is held by a live process and cannot be archived.`);
  }
  if (assessment.code === "pinned") {
    return new Error(`Run ${runId} is pinned and cannot be archived.`);
  }
  return new Error(
    `Run ${runId} is ${qualifier} storage-eligible and cannot be archived: ${assessment.message}`,
  );
}

function projectLockObservation(observation: RunLockObservation): StorageLockObservation {
  switch (observation.status) {
    case "missing":
      return "missing";
    case "observed":
      return observation.owner;
    case "malformed":
      return "malformed";
    case "unreadable":
      return "unreadable";
  }
}

function isTerminalTrackState(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Strict storage-facing event read. Unlike `readRunEvents`, this never skips a
 * malformed line: a present-but-malformed or torn trail is reported instead of
 * looking eventless. A missing file, a byte-budget truncation and an abort are
 * distinct outcomes so a caller can tell absent evidence from unread evidence.
 */
async function readStorageEvents(
  runDir: string,
  signal: AbortSignal | undefined,
): Promise<StorageEventRead> {
  const eventsPath = join(runDir, "events.jsonl");
  const read = await readBoundedTextFile(eventsPath, {
    maxBytes: STORAGE_EVENTS_MAX_BYTES,
    ...(signal === undefined ? {} : { signal }),
  });

  if (read.status === "missing") {
    return { status: "missing", events: [] };
  }
  if (read.status === "unreadable") {
    return {
      status: "unreadable",
      events: [],
      message: `The event trail at ${eventsPath} could not be read.`,
    };
  }
  if (read.aborted) {
    return {
      status: "aborted",
      events: [],
      message: "The event trail read was aborted, so eligibility is unknown.",
    };
  }
  if (read.truncated) {
    return {
      status: "partial",
      events: [],
      message: `The event trail is larger than the ${STORAGE_EVENTS_MAX_BYTES}-byte storage eligibility budget.`,
    };
  }

  const lines = read.text.split("\n");
  const hasTrailingNewline = read.text.endsWith("\n");
  const events: Event[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (index === lines.length - 1 && !hasTrailingNewline) {
        return {
          status: "partial",
          events: [],
          message: `The event trail ends with an unfinished line ${index + 1}.`,
        };
      }
      return {
        status: "malformed",
        events: [],
        message: `The event trail has malformed JSON at line ${index + 1}.`,
      };
    }

    if (!isStorageEvent(parsed)) {
      return {
        status: "malformed",
        events: [],
        message: `The event trail has a non-event record at line ${index + 1}.`,
      };
    }
    events.push(parsed);
  }

  return { status: "complete", events };
}

function isStorageEvent(value: unknown): value is Event {
  if (!isPlainObject(value)) {
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

function resolvePolicyDays(
  workflowPolicy: NonNullable<StorageLifecyclePolicy["workflows"]>[string] | undefined,
  defaultPolicy: StorageLifecyclePolicy,
  key: "archiveAfterDays" | "deleteAfterDays",
): number | undefined {
  if (workflowPolicy !== undefined && Object.hasOwn(workflowPolicy, key)) {
    const value = workflowPolicy[key];
    return value === false ? undefined : value;
  }
  const value = defaultPolicy[key];
  return value === false ? undefined : value;
}

function ageInDays(timestamp: string | undefined, now: Date): number | undefined {
  if (timestamp === undefined) {
    return undefined;
  }
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? (now.getTime() - time) / (24 * 60 * 60 * 1000) : undefined;
}

export function parseStorageLifecycleDurationDays(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/u.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return undefined;
  }
  const unit = match[2] as "ms" | "s" | "m" | "h" | "d" | "w";
  const daysByUnit: Record<typeof unit, number> = {
    ms: 1 / 86_400_000,
    s: 1 / 86_400,
    m: 1 / 1_440,
    h: 1 / 24,
    d: 1,
    w: 7,
  };
  return amount * daysByUnit[unit];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function validateStorageRunId(runsRoot: string, runId: string): Promise<string> {
  const validated = await validateRunIdentifier(runId, {
    cwd: process.cwd(),
    runsRoot,
    access: "mutate",
    form: "name",
  });
  return validated.runDir;
}
