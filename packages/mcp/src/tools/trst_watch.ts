/**
 * trst_watch — observe a TrailStep run's event stream over MCP.
 *
 * The run is resolved from the runs root — `<cwd>/.trailstep/runs` or the
 * `TRAILSTEP_RUNS_ROOT` override — through the shared `resolveRunsRoot` helper
 * from `@trailstep/core`, exactly like the CLI (`options.env`, defaulting to
 * `process.env`). Then it reads `<runDir>/events.jsonl` by byte offset (the
 * "cursor") and returns a header plus a capped slice of new complete event
 * lines. When nothing new is
 * available it long-polls by actually polling the file (default 50 ms interval
 * up to a 25 s budget, within the 20-30 s range) instead of returning a fake
 * timeout constant. The cursor is persisted atomically (tmp file + rename) at
 * `.trailstep/mcp/.cursor/<runId>.json` so reconnects reuse where they left
 * off; an explicit `params.cursor` overrides the persisted value.
 *
 * Test seams (`cwd` / `runDir` / `cursorDir` / `timeoutMs` / `pollIntervalMs`)
 * keep every artifact in caller-provided directories — tests never write the
 * repo's own `.trailstep/mcp`.
 */
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { isPathLike, isPlainObject, readRunEventsSince, resolveRunsRoot } from "@trailstep/core";

export type TrstWatchVerbosity = "brief" | "normal" | "full";

export type TrstWatchRunState = "started" | "in-progress" | "terminal";

export interface TrstWatchParams {
  /** Run name or run id to observe. */
  readonly runId?: string;
  /** Byte offset into `events.jsonl` to resume from; overrides the persisted cursor. */
  readonly cursor?: number;
  /** Output verbosity; caps emitted lines at 50 (brief) / 100 (normal) / 200 (full). */
  readonly verbosity?: TrstWatchVerbosity;
}

export interface TrstWatchOptions {
  /** Project root used to resolve the runs root and default cursor dir. */
  readonly cwd?: string;
  /** Explicit run directory (contains `events.jsonl`); overrides runId resolution. */
  readonly runDir?: string;
  /** Explicit cursor directory; defaults to `<cwd>/.trailstep/mcp/.cursor`. */
  readonly cursorDir?: string;
  /** Long-poll budget in ms; defaults to 25000 (20-30 s range). */
  readonly timeoutMs?: number;
  /** Poll interval in ms; defaults to 50 (matches `trailstep watch`). */
  readonly pollIntervalMs?: number;
  /** Env used to resolve `TRAILSTEP_RUNS_ROOT`; defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
}

export interface TrstWatchResult {
  /** One-line summary: runId, state, cursor, and number of emitted lines. */
  readonly header: string;
  readonly runId: string;
  /** New complete event lines (verbatim jsonl), capped by verbosity. */
  readonly lines: readonly string[];
  /** Byte offset into `events.jsonl` after the last emitted line; persisted. */
  readonly cursor: number;
  readonly state: TrstWatchRunState;
  /** Long-poll budget that was actually used, in ms. */
  readonly timeoutMs: number;
  /** True when more new lines existed than the verbosity cap allowed. */
  readonly truncated: boolean;
}

const defaultLongPollTimeoutMs = 25_000;
const minLongPollTimeoutMs = 20_000;
const maxLongPollTimeoutMs = 30_000;
const defaultPollIntervalMs = 50;
const minLineCap = 50;
const maxLineCap = 200;

const terminalEventPattern = /"type"\s*:\s*"workflow\.(?:completed|failed|cancelled)"/u;

/**
 * Watch a run's events since the current (or explicit) cursor.
 * Accepts either a params object or a bare runId string for callers that pass
 * the run id positionally.
 */
export async function trst_watch(
  params?: TrstWatchParams | string,
  options: TrstWatchOptions = {},
): Promise<TrstWatchResult> {
  const resolved: TrstWatchParams = typeof params === "string" ? { runId: params } : (params ?? {});
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

  const timeoutMs =
    options.timeoutMs ??
    Math.min(maxLongPollTimeoutMs, Math.max(minLongPollTimeoutMs, defaultLongPollTimeoutMs));
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const lineCap = verbosityLineCap(resolved.verbosity);

  // Long-poll: keep polling the file until new complete lines arrive (or a
  // partially written line completes, or malformed lines are consumed), or the
  // real time budget expires. Never a fixed sleep of the whole budget.
  const deadline = Date.now() + timeoutMs;
  let read = await readRunEventsSince(eventsFile, startCursor, {
    report: (message) => console.error(`trst_watch: ${message}`),
  });
  while (
    read.entries.length === 0 &&
    read.offset === startCursor &&
    !terminalEventPattern.test(read.text)
  ) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remaining));
    read = await readRunEventsSince(eventsFile, startCursor, {
      report: (message) => console.error(`trst_watch: ${message}`),
    });
  }

  const emitted = read.entries.slice(0, lineCap);
  const truncated = read.entries.length > emitted.length;
  // Cursor advances only through emitted lines so capped-out events remain
  // fetchable on the next call.
  const cursor = emitted.at(-1)?.endOffset ?? read.offset;
  const state = stateFromText(read.text);
  const lines = emitted.map((entry) => entry.line);

  await persistCursor(cursorFile, runId, cursor);

  return {
    header: `watch:${runId} state=${state} cursor=${cursor} lines=${lines.length}`,
    runId,
    lines,
    cursor,
    state,
    timeoutMs,
    truncated,
  };
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

function stateFromText(text: string): TrstWatchRunState {
  if (terminalEventPattern.test(text)) {
    return "terminal";
  }
  const completeText = text.slice(0, text.lastIndexOf("\n") + 1);
  return completeText.trim().length > 0 ? "in-progress" : "started";
}

function verbosityLineCap(verbosity?: TrstWatchVerbosity): number {
  const requested = verbosity === "brief" ? 50 : verbosity === "full" ? maxLineCap : 100;
  return Math.min(maxLineCap, Math.max(minLineCap, requested));
}

function cursorFileBaseName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/gu, "_");
}
