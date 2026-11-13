/**
 * Storage lifecycle: archive, restore, pin and delete run artifacts.
 *
 * `planStorageLifecycle`/`applyStorageLifecycle` operate on terminal, unpinned
 * runs. Direct name-addressed operations and lifecycle actions share the
 * canonical run-identifier validator in `runs/run-identifier.ts`, so a run id
 * cannot alias the runs root, its parent, or `.staging`/`.archive`.
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
import { isNodeError } from "../../json/guards.js";
import { validateRunIdentifier } from "../../runs/run-identifier.js";
import { defaultRunsRoot } from "../artifacts/run-storage.js";
import { isRunLockLive, readRunLock } from "../run-lock/run-lock.js";
import { listRunSummaries, type RunSummary } from "../runs/run-summaries.js";

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

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

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
    if (!isLifecycleEligible(summary) || (await isRunPinned(summary.runDir))) {
      continue;
    }
    // A terminal event trail is necessary but not sufficient: the scheduler
    // writes a terminal track before it emits workflow.completed, and a run
    // that is still finishing must never be archived or deleted underneath its
    // live driver. The lock is the only cross-process liveness signal here.
    //
    // Known limitation (TOCTOU): this read is not atomic with the later
    // archive/delete mutation. A process can acquire the lock after this check
    // and before `archiveRun`/`deleteRun` renames or removes the directory, so
    // a just-started run may still be archived or deleted. A future fix would
    // hold an exclusive lifecycle lock across the mutation, or make the
    // mutation a compare-and-swap directory rename.
    //
    // Known limitation (reused pid): liveness is pid-only, so a stale lock
    // whose pid was recycled by an unrelated live process keeps this run out
    // of the plan forever. There is intentionally no stale-lock escape here;
    // see `assertRunNotLiveLocked` for the same limitation on direct calls.
    if (isRunLockLive(await readRunLock(summary.runDir))) {
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
        reason: `${summary.status} run is ${Math.floor(ageDays)}d old (deleteAfterDays=${deleteAfterDays})`,
      });
    } else if (archiveAfterDays !== undefined && ageDays >= archiveAfterDays) {
      actions.push({
        action: "archive",
        runId: summary.runId,
        path: summary.runDir,
        reason: `${summary.status} run is ${Math.floor(ageDays)}d old (archiveAfterDays=${archiveAfterDays})`,
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
      await deleteRun({ runsRoot, runId: action.runId });
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
}): Promise<void> {
  const runDir = await validateStorageRunId(options.runsRoot, options.runId);
  await assertRunNotLiveLocked(runDir, options.runId, "archived");
  const summaries = await listRunSummaries({
    cwd: dirname(dirname(options.runsRoot)),
    runsRoot: options.runsRoot,
  });
  const summary = summaries.find(
    (candidate) => candidate.runId === options.runId && candidate.status !== "archived",
  );
  if (summary === undefined || !isLifecycleEligible(summary)) {
    throw new Error(`Run ${options.runId} is not a terminal readable run and cannot be archived.`);
  }
  if (await isRunPinned(runDir)) {
    throw new Error(`Run ${options.runId} is pinned and cannot be archived.`);
  }

  const manifest: ArchiveManifest = {
    schemaVersion: 1,
    runId: options.runId,
    archivedAt: (options.now ?? new Date()).toISOString(),
    sourceRunDir: runDir,
    ...(summary.workflowId === undefined ? {} : { workflowId: summary.workflowId }),
    ...(summary.lastTimestamp === undefined ? {} : { lastTimestamp: summary.lastTimestamp }),
    status: summary.status,
  };
  const payload: ArchivePayload = { manifest, files: await readDirectoryPayload(runDir) };
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
    await assertRunNotLiveLocked(runDir, options.runId, "deleted");
    if (await isRunPinned(runDir)) {
      throw new Error(`Run ${options.runId} is pinned and cannot be deleted.`);
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
  try {
    await stat(storagePinPath(runDir));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
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

function isLifecycleEligible(summary: RunSummary): boolean {
  // The summary status is the single eligibility signal. A genuinely
  // event-less run is already terminal here because `summarizeEventlessTrack`
  // derives its status from the track; a run with an event trail must be
  // finished by that trail, never by a terminal track written just before the
  // terminal event.
  return TERMINAL_STATUSES.has(summary.status);
}

/**
 * Refuse to mutate a run that a live process is still driving. `planStorageLifecycle`
 * skips these runs; the direct archive/delete entry points enforce it too so a
 * caller cannot bypass the planner.
 *
 * Known limitation (TOCTOU): the lock read and the caller's subsequent rename
 * or removal are not one atomic operation. A process can acquire the lock after
 * this check but before the mutation. A future fix would hold an exclusive
 * lifecycle lock across the mutation, or make it a compare-and-swap rename.
 *
 * Known limitation (reused pid): liveness is pid-only, so a stale `run.lock`
 * whose pid was recycled by an unrelated live process blocks archive/delete
 * forever. This is intentionally not escaped here; a future fix would check
 * process start time or a boot identifier, or offer an operator-approved
 * escape.
 */
async function assertRunNotLiveLocked(
  runDir: string,
  runId: string,
  action: "archived" | "deleted",
): Promise<void> {
  if (isRunLockLive(await readRunLock(runDir))) {
    throw new Error(`Run ${runId} is held by a live process and cannot be ${action}.`);
  }
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
