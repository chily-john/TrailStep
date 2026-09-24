import { createReadStream, type Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { defaultRunsRoot } from "../artifacts/run-storage.js";
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
  assertRunId(options.runId);
  const runDir = join(options.runsRoot, options.runId);
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

export async function restoreArchivedRun(options: {
  readonly runsRoot: string;
  readonly runId: string;
}): Promise<void> {
  assertRunId(options.runId);
  const payloadPath = archivePayloadPath(options.runsRoot, options.runId);
  const manifestPath = archiveManifestPath(options.runsRoot, options.runId);
  const runDir = join(options.runsRoot, options.runId);
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
  assertRunId(options.runId);
  const runDir = join(options.runsRoot, options.runId);
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
  assertRunId(options.runId);
  const runDir = join(options.runsRoot, options.runId);
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
  assertRunId(options.runId);
  const runDir = join(options.runsRoot, options.runId);
  if (await pathExists(runDir)) {
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
  assertRunId(options.runId);
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
  return TERMINAL_STATUSES.has(summary.status);
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

function assertRunId(runId: string): void {
  if (runId !== basename(runId) || runId === "." || runId === ".." || runId.trim() === "") {
    throw new Error("Run id must be a single path segment.");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
