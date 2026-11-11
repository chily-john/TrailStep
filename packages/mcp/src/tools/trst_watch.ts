/**
 * trst_watch — attention-based observation of a TrailStep run over MCP.
 *
 * The run is resolved from the runs root — `<cwd>/.trailstep/runs` or the
 * `TRAILSTEP_RUNS_ROOT` override — through the shared `resolveRunsRoot` helper
 * from `@trailstep/core`, exactly like the CLI (`options.env`, defaulting to
 * `process.env`). Then it reads `<runDir>/events.jsonl` by byte offset (the
 * "cursor").
 *
 * The result is a compact digest, not a tail of raw JSONL: state, cursor,
 * budget, and exactly one payload (terminal `output`, pending `waits`,
 * `crash`, or `progress`). Raw `lines` are populated only for `verbosity:
 * "full"`, which keeps the old capped tail-follow behaviour (brief 50 /
 * normal 100 / full 200 lines, cursor only through emitted lines so capped-out
 * events stay fetchable). In compact mode every read event is digested by the
 * server, so the persisted cursor advances to the last consumed read offset.
 *
 * Run state is classified from the run's **parsed events** plus its run lock
 * (never from a regex over raw file text, which could match event-shaped text
 * embedded in agent output). A run parked on a durable wait is `waiting`, which
 * outranks a live lock: the answer/continue is the operator's move. `crashed`
 * means the trail has no terminal event and no live process holds the run, so
 * nothing will ever append one — stop waiting.
 *
 * The long-poll budget is capped by an explicit effective ceiling: a
 * progressless client (the default) waits at most `progresslessCeilingMs`
 * (25 s), while a progress-capable client may use `progressCapableCeilingMs`
 * (300 s). A capable client can also install `onProgress`: it fires once
 * immediately and then at most once per `progressIntervalMs` (10 s) from
 * inside the poll loop, without changing the polling cadence. `waitFor:
 * "attention"` returns immediately for `waiting`; `waitFor: "terminal"` keeps
 * polling through a pending wait until new lines arrive, the state settles,
 * the budget expires, or `options.signal` aborts. A deadline exit still
 * reports the honest state (`waiting` plus `waits[]` for a parked run).
 *
 * Terminal results are additive: `workflow.completed` returns payload.output
 * verbatim, while `workflow.failed` / `workflow.cancelled` also return the
 * structured `failure` the caller must react to when the payload carries one.
 *
 * Test seams (`cwd` / `runDir` / `cursorDir` / `maxWaitMs` / `pollIntervalMs` /
 * `progressIntervalMs` / `progresslessCeilingMs` /
 * `progressCapableCeilingMs` / `signal`) keep every artifact in
 * caller-provided directories — tests never write the repo's own
 * `.trailstep/mcp`.
 */
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type Event,
  isPathLike,
  isPlainObject,
  isRunLockLive,
  listPendingWaits,
  readRunEvents,
  readRunEventsSince,
  readRunLock,
  readWaitAnswerFile,
  readWaitQuestion,
  resolveRunsRoot,
  waitEventBranchId,
} from "@trailstep/core";

export type TrstWatchVerbosity = "brief" | "normal" | "full";

export type TrstWatchWaitFor = "attention" | "terminal";

export type TrstWatchRunState = "started" | "in-progress" | "waiting" | "terminal" | "crashed";

export interface TrstWatchParams {
  /** Run name or run id to observe. */
  readonly runId: string;
  /** Byte offset into `events.jsonl` to resume from; overrides the persisted cursor. */
  readonly cursor?: number;
  /** Output verbosity; raw `lines` are only populated for "full". */
  readonly verbosity?: TrstWatchVerbosity;
  /** Requested long-poll budget in ms; 0 means a single-shot snapshot. Defaults to 300000. */
  readonly maxWaitMs?: number;
  /** "attention" (default) returns immediately for `waiting`; "terminal" polls through it. */
  readonly waitFor?: TrstWatchWaitFor;
}

export interface TrstWatchOptions {
  /** Project root used to resolve the runs root and default cursor dir. */
  readonly cwd?: string;
  /** Explicit run directory (contains `events.jsonl`); overrides runId resolution. */
  readonly runDir?: string;
  /** Explicit cursor directory; defaults to `<cwd>/.trailstep/mcp/.cursor`. */
  readonly cursorDir?: string;
  /** Test seam for the requested budget; `params.maxWaitMs` takes precedence. */
  readonly maxWaitMs?: number;
  /** Poll interval in ms; defaults to 50 (matches `trailstep watch`). */
  readonly pollIntervalMs?: number;
  /** Env used to resolve `TRAILSTEP_RUNS_ROOT`; defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
  /** Whether the caller can receive progress notifications (raises the wait ceiling). */
  readonly progressCapable?: boolean;
  /** Effective ceiling for progressless callers; defaults to 25000. */
  readonly progresslessCeilingMs?: number;
  /** Effective ceiling for progress-capable callers; defaults to 300000. */
  readonly progressCapableCeilingMs?: number;
  /**
   * Per-poll progress hook: called once immediately, then at most once per
   * `progressIntervalMs` while the watch is polling. Best-effort and
   * synchronous; the caller must not block on it.
   */
  readonly onProgress?: (progress: TrstWatchProgressEvent) => void;
  /** Progress hook cadence in ms; defaults to 10000 (10 s). */
  readonly progressIntervalMs?: number;
  /** Aborts the poll promptly and returns a snapshot instead of throwing. */
  readonly signal?: AbortSignal;
}

/** One unresolved wait a caller must answer or resolve. */
export interface TrstWatchWait {
  readonly waitId: string;
  readonly stepId?: string;
  readonly branchId: string;
  readonly question?: string;
  readonly answerFile?: string;
}

/** Digest of an open run: newest step, newest event type, and this call's new event count. */
export interface TrstWatchProgress {
  readonly step?: string;
  readonly lastEventType?: Event["type"];
  readonly newEvents: number;
}

/**
 * The per-poll payload passed to `onProgress`: the compact result's progress
 * digest plus the classified state and the clamped budget, which the MCP
 * server needs to build a notification message and its total.
 */
export interface TrstWatchProgressEvent extends TrstWatchProgress {
  readonly state: TrstWatchRunState;
  readonly effectiveWaitMs: number;
}

/** The structured failure an agent needs in order to react to a terminal run. */
export interface TrstWatchFailure {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface TrstWatchResult {
  /** One-line summary: runId, state, cursor, and emitted line count. */
  readonly header: string;
  readonly runId: string;
  readonly state: TrstWatchRunState;
  /** Byte offset into `events.jsonl` after the last consumed/emitted line; persisted. */
  readonly cursor: number;
  /** The requested long-poll budget (params.maxWaitMs, or the 300000 default). */
  readonly requestedWaitMs: number;
  /** The clamped budget actually used (never unlimited). */
  readonly effectiveWaitMs: number;
  /** True when more new lines existed than the `full` verbosity cap allowed. */
  readonly truncated: boolean;
  /** Terminal event payload.output, verbatim, for `state: "terminal"`. */
  readonly output?: unknown;
  /** Structured failure for a failed/cancelled terminal event, when present. */
  readonly failure?: TrstWatchFailure;
  /** Every unresolved wait, for `state: "waiting"`. */
  readonly waits?: readonly TrstWatchWait[];
  /** Why the run is considered dead, for `state: "crashed"`. */
  readonly crash?: { readonly reason: string };
  /** Open-run digest, for the remaining states. */
  readonly progress?: TrstWatchProgress;
  /** Raw JSONL lines, only populated when `verbosity` is "full". */
  readonly lines: readonly string[];
}

const defaultMaxWaitMs = 300_000;
const defaultProgresslessCeilingMs = 25_000;
const defaultProgressCapableCeilingMs = 300_000;
const defaultPollIntervalMs = 50;
const defaultProgressIntervalMs = 10_000;
const minLineCap = 50;
const maxLineCap = 200;
const crashReason = "no terminal event and no live lock";

/**
 * The event types that end a run. Anything else leaves it open.
 */
const terminalEventTypes: readonly Event["type"][] = [
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
];

/**
 * Watch a run's events since the current (or explicit) cursor.
 * Accepts either a params object or a bare runId string for callers that pass
 * the run id positionally.
 */
export async function trst_watch(
  params?: TrstWatchParams | string,
  options: TrstWatchOptions = {},
): Promise<TrstWatchResult> {
  const resolved: Partial<TrstWatchParams> =
    typeof params === "string" ? { runId: params } : (params ?? {});
  const runId =
    typeof resolved.runId === "string" && resolved.runId.trim().length > 0
      ? resolved.runId.trim()
      : undefined;
  if (runId === undefined) {
    throw new Error("trst_watch requires params.runId (the run name or run id to observe).");
  }

  const cwd = options.cwd ?? process.cwd();
  const runsRoot = resolveRunsRoot({ cwd, env: options.env ?? process.env });
  const eventsFile = resolveEventsFile(cwd, runsRoot, runId, options.runDir);
  const runDir = path.dirname(eventsFile);
  await requireEventsFile(eventsFile, runId);

  const cursorDir = options.cursorDir ?? path.join(cwd, ".trailstep", "mcp", ".cursor");
  const cursorFile = path.join(cursorDir, `${cursorFileBaseName(runId)}.json`);
  const explicitCursor =
    typeof resolved.cursor === "number" && Number.isFinite(resolved.cursor) && resolved.cursor >= 0
      ? resolved.cursor
      : undefined;
  const persistedCursor =
    explicitCursor === undefined ? await readPersistedCursor(cursorFile, runId) : undefined;
  const startCursor = explicitCursor ?? persistedCursor ?? 0;

  const requestedWaitMs = resolveRequestedWaitMs(resolved.maxWaitMs, options.maxWaitMs);
  const progresslessCeilingMs = resolveCeiling(
    options.progresslessCeilingMs,
    defaultProgresslessCeilingMs,
  );
  const progressCapableCeilingMs = resolveCeiling(
    options.progressCapableCeilingMs,
    defaultProgressCapableCeilingMs,
  );
  const effectiveWaitMs =
    requestedWaitMs === 0
      ? 0
      : Math.min(
          requestedWaitMs,
          options.progressCapable === true ? progressCapableCeilingMs : progresslessCeilingMs,
        );
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? defaultPollIntervalMs);
  const progressIntervalMs = resolveProgressIntervalMs(options.progressIntervalMs);
  const waitFor: TrstWatchWaitFor = resolved.waitFor === "terminal" ? "terminal" : "attention";
  const fullMode = resolved.verbosity === "full";
  const lineCap = verbosityLineCap(resolved.verbosity);
  const readOptions = {
    report: (message: string) => console.error(`trst_watch: ${message}`),
  };

  // Long-poll: poll the file until new complete lines arrive (or malformed
  // lines are consumed), or the run needs attention (waiting/terminal/crashed),
  // or the effective budget expires, or the signal aborts. Never a fixed sleep
  // of the whole budget. Classification on idle polls reuses the full trail
  // parsed at entry and only re-reads the small run lock, so a long run's watch
  // does not re-decode the whole trail every poll; when new lines appear the
  // trail is parsed once more to report the honest final state.
  const deadline = Date.now() + effectiveWaitMs;
  let observed = await readTrail(runDir);
  let classification = await classifyRunState({ runDir, events: observed });
  let read = await readRunEventsSince(eventsFile, startCursor, readOptions);
  let consumedNewData = read.entries.length > 0 || read.offset !== startCursor;

  // Progress is best-effort and synchronous: one notification immediately at
  // the start of the call, then at most one per progressIntervalMs of polling.
  // A throwing observer never changes the watch result, and an abort stops
  // further emissions because the poll loop exits.
  let lastProgressAt = Date.now();
  const notifyProgress = (state: TrstWatchRunState): void => {
    if (options.onProgress === undefined || options.signal?.aborted === true) {
      return;
    }
    lastProgressAt = Date.now();
    try {
      options.onProgress({
        ...describeProgress(observed, read.entries.length),
        state,
        effectiveWaitMs,
      });
    } catch {
      // Progress is advisory; it must never fail the watch itself.
    }
  };

  notifyProgress(classification.state);

  while (!consumedNewData) {
    if (shouldExitForState(classification.state, waitFor)) {
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    if (options.signal?.aborted === true) {
      break;
    }

    try {
      await sleep(Math.min(pollIntervalMs, remaining), undefined, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) {
        break;
      }
      if (isAbortError(error)) {
        break;
      }
      throw error;
    }

    read = await readRunEventsSince(eventsFile, startCursor, readOptions);
    consumedNewData = read.entries.length > 0 || read.offset !== startCursor;
    if (!consumedNewData) {
      classification = await classifyRunState({ runDir, events: observed });
      if (options.onProgress !== undefined && Date.now() - lastProgressAt >= progressIntervalMs) {
        notifyProgress(classification.state);
      }
    }
  }

  if (consumedNewData) {
    observed = await readTrail(runDir);
    classification = await classifyRunState({ runDir, events: observed });
  }

  const emitted = read.entries.slice(0, lineCap);
  const truncated = fullMode && read.entries.length > emitted.length;
  // `full` keeps the old semantics: the cursor advances only through emitted
  // lines so capped-out events remain fetchable on the next call. Compact mode
  // digested every read event server-side, so it advances through the whole read.
  const cursor = fullMode ? (emitted.at(-1)?.endOffset ?? read.offset) : read.offset;
  const lines = fullMode ? emitted.map((entry) => entry.line) : [];

  await persistCursor(cursorFile, runId, cursor);

  const base = {
    header: `watch:${runId} state=${classification.state} cursor=${cursor} lines=${lines.length}`,
    runId,
    state: classification.state,
    cursor,
    requestedWaitMs,
    effectiveWaitMs,
    truncated,
    lines,
  };

  switch (classification.state) {
    case "terminal": {
      const terminal = findTerminalEvent(observed);
      if (terminal === undefined) {
        return base;
      }
      if (terminal.type === "workflow.completed") {
        const output = terminal.payload.output;
        return output === undefined ? base : { ...base, output };
      }
      const failure = describeTerminalFailure(terminal);
      return failure === undefined ? base : { ...base, failure };
    }
    case "waiting":
      return { ...base, waits: toPendingWaits(observed) };
    case "crashed":
      return { ...base, crash: { reason: crashReason } };
    default:
      return { ...base, progress: describeProgress(observed, read.entries.length) };
  }
}

/**
 * Persist the cursor atomically: write a tmp file, then rename over the target.
 * The tmp suffix is randomized per call so overlapping polls in one process
 * (same pid) never collide on the same tmp path, and the rename retries briefly
 * because Windows can transiently refuse a replace (EPERM/EBUSY) while another
 * overlapping poll or a scanner still touches the target.
 */
async function persistCursor(cursorFile: string, runId: string, cursor: number): Promise<void> {
  await mkdir(path.dirname(cursorFile), { recursive: true });
  const tmpFile = `${cursorFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify({ runId, cursor })}\n`, "utf8");
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(tmpFile, cursorFile);
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      await sleep(15 * attempt);
    }
  }
}

/** Read the persisted cursor so a reconnect resumes where it left off. */
async function readPersistedCursor(cursorFile: string, runId: string): Promise<number | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cursorFile, "utf8"));
    if (
      isPlainObject(parsed) &&
      typeof parsed.cursor === "number" &&
      Number.isFinite(parsed.cursor) &&
      parsed.cursor >= 0 &&
      (typeof parsed.runId !== "string" || parsed.runId === runId)
    ) {
      return parsed.cursor;
    }
  } catch {
    // No usable cursor yet — start from the beginning.
  }
  return undefined;
}

function resolveEventsFile(cwd: string, runsRoot: string, runId: string, runDir?: string): string {
  if (runDir !== undefined) {
    return path.resolve(runDir, "events.jsonl");
  }
  if (isPathLike(runId)) {
    return path.resolve(cwd, runId, "events.jsonl");
  }
  return path.join(runsRoot, runId, "events.jsonl");
}

async function requireEventsFile(eventsFile: string, runId: string): Promise<void> {
  try {
    await access(eventsFile);
  } catch {
    throw new Error(`trst_watch: run not found or unreadable: ${runId} (${eventsFile})`);
  }
}

/**
 * Classify a run from its parsed events plus its lock.
 *
 * Order matters: a pending wait outranks a live lock (a run parked on a durable
 * wait has no process by design) and a terminal event outranks everything.
 * `crashed` is the state a raw trail scan cannot express: no terminal event and
 * no live lock holder, so nothing will ever append one.
 */
async function classifyRunState(options: {
  readonly runDir: string;
  readonly events: readonly Event[];
}): Promise<{ readonly state: TrstWatchRunState }> {
  if (findTerminalEvent(options.events) !== undefined) {
    return { state: "terminal" };
  }

  if (options.events.length === 0) {
    return { state: "started" };
  }

  if (listPendingWaits(options.events).length > 0) {
    return { state: "waiting" };
  }

  const lock = await readRunLock(options.runDir);
  if (lock !== undefined && isRunLockLive(lock)) {
    return { state: "in-progress" };
  }

  return { state: "crashed" };
}

/**
 * Full parse of the run's trail, tolerating a trail that vanished or cannot be read: a watch
 * must not fail merely because the state could not be classified.
 */
async function readTrail(runDir: string): Promise<readonly Event[]> {
  try {
    return await readRunEvents(runDir);
  } catch {
    return [];
  }
}

function findTerminalEvent(events: readonly Event[]): Event | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && terminalEventTypes.includes(event.type)) {
      return event;
    }
  }
  return undefined;
}

/**
 * Extract the failure an agent must react to from a failed/cancelled terminal
 * event. `workflow.failed` payloads carry `{ failure, message? }`; a cancelled
 * payload carries a failure only when the runtime supplied one. A failed
 * event always reports something (falling back to the top-level message), so
 * the caller is never left with an unexplained terminal state.
 */
function describeTerminalFailure(event: Event): TrstWatchFailure | undefined {
  if (event.type === "workflow.completed") {
    return undefined;
  }
  const payloadFailure = isPlainObject(event.payload.failure) ? event.payload.failure : undefined;
  if (event.type === "workflow.cancelled" && payloadFailure === undefined) {
    return undefined;
  }

  const topLevelMessage = readNonEmptyString(event.payload.message);
  const code = payloadFailure === undefined ? undefined : readNonEmptyString(payloadFailure.code);
  const message =
    payloadFailure === undefined
      ? topLevelMessage
      : (readNonEmptyString(payloadFailure.message) ?? topLevelMessage);
  const isFailure = event.type === "workflow.failed";

  return {
    code: code ?? (isFailure ? "workflow_failed" : "workflow_cancelled"),
    message: message ?? (isFailure ? "workflow failed" : "workflow cancelled"),
    ...(payloadFailure?.details === undefined ? {} : { details: payloadFailure.details }),
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function toPendingWaits(events: readonly Event[]): TrstWatchWait[] {
  return listPendingWaits(events).map((event) => ({
    waitId: typeof event.payload.waitId === "string" ? event.payload.waitId : "",
    stepId: event.stepId,
    branchId: waitEventBranchId(event),
    question: readWaitQuestion(event),
    answerFile: readWaitAnswerFile(event),
  }));
}

function describeProgress(events: readonly Event[], newEvents: number): TrstWatchProgress {
  let step: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.stepId !== undefined) {
      step = event.stepId;
      break;
    }
  }

  return {
    step,
    lastEventType: events.at(-1)?.type,
    newEvents,
  };
}

function shouldExitForState(state: TrstWatchRunState, waitFor: TrstWatchWaitFor): boolean {
  if (state === "terminal" || state === "crashed") {
    return true;
  }
  return state === "waiting" && waitFor === "attention";
}

function verbosityLineCap(verbosity?: TrstWatchVerbosity): number {
  const requested = verbosity === "brief" ? 50 : verbosity === "full" ? maxLineCap : 100;
  return Math.min(maxLineCap, Math.max(minLineCap, requested));
}

function resolveRequestedWaitMs(param: number | undefined, option: number | undefined): number {
  const candidate = param ?? option ?? defaultMaxWaitMs;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : defaultMaxWaitMs;
}

function resolveCeiling(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveProgressIntervalMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : defaultProgressIntervalMs;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "AbortError"
  );
}

function cursorFileBaseName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/gu, "_");
}
