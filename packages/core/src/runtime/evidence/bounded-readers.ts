import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import type { Event } from "../../contracts/events/event.types.js";
import type {
  EvidenceCoverage,
  EvidenceDiagnostic,
} from "../../contracts/evidence/evidence.types.js";
import { isNodeError } from "../../json/guards.js";

/**
 * Bounded, genuinely streaming readers for read-only evidence queries.
 *
 * These helpers never call `readFile` on a growing trail. They `stat` first,
 * then open a `createReadStream` capped by a byte budget and abort the stream
 * when the byte/line/event/deadline budget is exhausted. The result carries a
 * typed `budget-exceeded` diagnostic and `coverage: partial` instead of
 * throwing or silently pretending the trail was fully read.
 */

export interface BoundedTextFileRead {
  readonly status: "ok" | "missing" | "unreadable";
  readonly text: string;
  readonly bytesRead: number;
  readonly fileSize: number;
  readonly truncated: boolean;
  readonly aborted: boolean;
}

/** Read at most `maxBytes` from a regular file without `readFile`ing it. */
export async function readBoundedTextFile(
  path: string,
  options: { readonly maxBytes: number; readonly signal?: AbortSignal },
): Promise<BoundedTextFileRead> {
  let fileSize: number;
  try {
    fileSize = (await stat(path)).size;
  } catch (error) {
    return {
      status: isNodeError(error) && error.code === "ENOENT" ? "missing" : "unreadable",
      text: "",
      bytesRead: 0,
      fileSize: 0,
      truncated: false,
      aborted: false,
    };
  }

  if (isAborted(options.signal)) {
    return {
      status: "ok",
      text: "",
      bytesRead: 0,
      fileSize,
      truncated: fileSize > 0,
      aborted: true,
    };
  }

  const limit = Math.max(0, Math.min(fileSize, options.maxBytes));
  if (limit === 0) {
    return {
      status: "ok",
      text: "",
      bytesRead: 0,
      fileSize,
      truncated: fileSize > 0,
      aborted: false,
    };
  }

  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let aborted = false;
  try {
    const stream = createReadStream(path, {
      start: 0,
      end: limit - 1,
      highWaterMark: 64 * 1024,
    });
    for await (const chunk of stream) {
      if (isAborted(options.signal)) {
        aborted = true;
        stream.destroy();
        break;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      bytesRead += buffer.length;
    }
  } catch (error) {
    return {
      status: isNodeError(error) && error.code === "ENOENT" ? "missing" : "unreadable",
      text: Buffer.concat(chunks).toString("utf8"),
      bytesRead,
      fileSize,
      truncated: fileSize > bytesRead || aborted,
      aborted,
    };
  }

  return {
    status: "ok",
    text: Buffer.concat(chunks).toString("utf8"),
    bytesRead,
    fileSize,
    truncated: fileSize > bytesRead || aborted,
    aborted,
  };
}

export interface RunEventsScanOptions {
  readonly eventsFile: string;
  readonly maxBytes: number;
  readonly maxLineBytes: number;
  readonly maxEvents: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Optional retention predicate. The listing path retains only state-relevant
   * events, so memory stays flat even for a 10k+ event trail. A matching event
   * is still fully parsed; non-matching events are discarded immediately.
   */
  readonly retain?: (event: Event) => boolean;
}

export interface RunEventsScanResult {
  readonly status: "ok" | "missing" | "unreadable";
  /** Retained events only, in trail order. */
  readonly events: readonly Event[];
  /** Last parsed event, retained even when the predicate rejects it. */
  readonly lastEvent?: Event;
  readonly scannedEvents: number;
  readonly malformedLines: number;
  readonly bytesRead: number;
  readonly nextOffset: number;
  readonly fileSize: number;
  /** True only when the whole existing file was scanned within every budget. */
  readonly complete: boolean;
  readonly coverage: EvidenceCoverage;
  readonly diagnostics: readonly EvidenceDiagnostic[];
}

/**
 * Stream a run's `events.jsonl` under explicit budgets.
 *
 * - `stat` happens before the file is opened (bounds-before-read).
 * - The stream is capped at `maxBytes`; a larger file stops at the cap.
 * - A line longer than `maxLineBytes` aborts the stream instead of buffering it.
 * - Exhausting bytes/lines/events/deadline reports `budget-exceeded`.
 * - A malformed or non-event line is counted and skipped, never thrown.
 */
export async function scanRunEventsBounded(
  options: RunEventsScanOptions,
): Promise<RunEventsScanResult> {
  const empty = (
    status: RunEventsScanResult["status"],
    diagnostics: readonly EvidenceDiagnostic[],
    fileSize = 0,
  ): RunEventsScanResult => ({
    status,
    events: [],
    scannedEvents: 0,
    malformedLines: 0,
    bytesRead: 0,
    nextOffset: 0,
    fileSize,
    complete: false,
    coverage: "unknown",
    diagnostics,
  });

  let fileSize: number;
  try {
    fileSize = (await stat(options.eventsFile)).size;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return empty("missing", [
        { code: "missing-source", message: "The run event trail does not exist." },
      ]);
    }
    return empty("unreadable", [
      { code: "unreadable-source", message: "The run event trail could not be read." },
    ]);
  }

  const maxBytes = Math.max(0, options.maxBytes);
  const readLimit = Math.min(fileSize, maxBytes);
  const diagnostics: EvidenceDiagnostic[] = [];
  let budgetExceeded = false;
  let aborted = false;
  let readError = false;

  if (isAborted(options.signal)) {
    return {
      ...empty(
        "ok",
        [{ code: "budget-exceeded", message: "The evidence query was aborted before reading." }],
        fileSize,
      ),
      complete: false,
      coverage: "partial",
    };
  }

  if (readLimit === 0) {
    const complete = fileSize === 0;
    return {
      ...empty(
        "ok",
        complete ? [] : [{ code: "budget-exceeded", message: "The event byte budget is zero." }],
        fileSize,
      ),
      complete,
      coverage: complete ? "complete" : "partial",
    };
  }

  const deadline =
    options.deadlineMs === undefined ? undefined : Date.now() + Math.max(0, options.deadlineMs);
  const retained: Event[] = [];
  let lastEvent: Event | undefined;
  let scannedEvents = 0;
  let malformedLines = 0;
  let bytesRead = 0;
  let nextOffset = 0;
  let pending = "";
  let lineStartOffset = 0;
  const decoder = new StringDecoder("utf8");

  const pushBudgetDiagnostic = (message: string): void => {
    if (budgetExceeded) {
      return;
    }
    budgetExceeded = true;
    diagnostics.push({ code: "budget-exceeded", message });
  };

  const budgetHit = (): boolean => {
    if (isAborted(options.signal)) {
      aborted = true;
      return true;
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      pushBudgetDiagnostic("The evidence query deadline was exceeded.");
      return true;
    }
    return false;
  };

  const consumeLine = (line: string, terminatorBytes: number): boolean => {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const endOffset = lineStartOffset + lineBytes + terminatorBytes;
    lineStartOffset = endOffset;
    if (lineBytes > options.maxLineBytes) {
      pushBudgetDiagnostic("An event line exceeded the line byte budget.");
      return false;
    }
    if (line.trim().length === 0) {
      nextOffset = endOffset;
      return true;
    }

    scannedEvents += 1;
    if (scannedEvents > options.maxEvents) {
      pushBudgetDiagnostic("The event count budget was exceeded.");
      return false;
    }

    if (budgetHit()) {
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      nextOffset = endOffset;
      return true;
    }

    if (isEventLike(parsed) === false) {
      malformedLines += 1;
      nextOffset = endOffset;
      return true;
    }

    lastEvent = parsed;
    if (options.retain === undefined || options.retain(parsed)) {
      retained.push(parsed);
    }
    nextOffset = endOffset;
    return true;
  };

  let streamError = false;
  try {
    const stream = createReadStream(options.eventsFile, {
      start: 0,
      end: readLimit - 1,
      highWaterMark: 64 * 1024,
    });
    readLoop: for await (const chunk of stream) {
      if (budgetHit()) {
        stream.destroy();
        break;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.length;
      pending += decoder.write(buffer);

      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        if (consumeLine(line, 1) === false) {
          stream.destroy();
          break readLoop;
        }
        newlineIndex = pending.indexOf("\n");
      }

      // Protect memory even before a newline arrives: a single 1 GB line must
      // not be buffered just to discover it is too long.
      if (Buffer.byteLength(pending, "utf8") > options.maxLineBytes) {
        pushBudgetDiagnostic("An event line exceeded the line byte budget.");
        stream.destroy();
        break;
      }
    }
  } catch {
    streamError = true;
    readError = true;
  }

  // A trailing line without a newline is only safe to parse when the whole
  // file was read. Under a byte cap it may be a line fragment that continues
  // past the budget, so it stays unparsed and coverage becomes partial.
  if (streamError === false) {
    pending += decoder.end();
  }

  const wholeFileRead = readLimit >= fileSize;
  if (
    wholeFileRead &&
    budgetExceeded === false &&
    aborted === false &&
    streamError === false &&
    pending.length > 0
  ) {
    if (Buffer.byteLength(pending, "utf8") > options.maxLineBytes) {
      pushBudgetDiagnostic("An event line exceeded the line byte budget.");
    } else {
      consumeLine(pending, 0);
    }
  }

  if (readLimit < fileSize) {
    pushBudgetDiagnostic("The event byte budget truncated the trail.");
  }

  if (malformedLines > 0) {
    diagnostics.push({
      code: "malformed-record",
      message: `${malformedLines} event line(s) were malformed or not event-shaped and were skipped.`,
    });
  }
  if (readError) {
    diagnostics.push({
      code: "unreadable-source",
      message: "Reading the event trail failed before it completed.",
    });
  }

  const complete =
    readError === false &&
    budgetExceeded === false &&
    aborted === false &&
    wholeFileRead &&
    bytesRead >= readLimit;

  if (aborted) {
    diagnostics.push({
      code: "budget-exceeded",
      message: "The evidence query was aborted while reading the event trail.",
    });
  }
  const coverage: EvidenceCoverage =
    complete && diagnostics.length === 0 ? "complete" : bytesRead === 0 ? "unknown" : "partial";

  return {
    status: readError && bytesRead === 0 ? "unreadable" : "ok",
    events: retained,
    ...(lastEvent === undefined ? {} : { lastEvent }),
    scannedEvents,
    malformedLines,
    bytesRead,
    nextOffset,
    fileSize,
    complete,
    coverage,
    diagnostics,
  };
}

/** Convenience bounded reader that retains every parsed event (up to `maxEvents`). */
export async function readRunEventsBounded(
  options: Omit<RunEventsScanOptions, "retain">,
): Promise<RunEventsScanResult> {
  return scanRunEventsBounded(options);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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
