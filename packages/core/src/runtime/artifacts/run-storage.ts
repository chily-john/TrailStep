import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";

export type RunState = Record<string, unknown>;

export function defaultRunsRoot(cwd: string): string {
  return join(cwd, ".trailstep", "runs");
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

    if (!isRunState(parsed)) {
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
 * scans or a competing replace) and worth a short bounded retry. */
const retryableRenameCodes: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const renameMaxAttempts = 4;

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
      await new Promise((resolve) => {
        setTimeout(resolve, 25 * attempt);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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

function isRunState(value: unknown): value is RunState {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

async function ensureTrailStepGitignoreForRunsRoot(runsRoot: string): Promise<void> {
  const trailstepRoot = dirname(runsRoot);
  if (basename(trailstepRoot) !== ".trailstep") {
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
