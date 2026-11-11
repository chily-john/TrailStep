import { type FileHandle, open } from "node:fs/promises";

import type { ProviderEvidenceDiagnostic } from "@trailstep/core";

import {
  type PiSessionHeader,
  type PiSessionUsageRecord,
  parsePiSessionHeader,
  parsePiSessionRecord,
} from "./pi-session-format.js";

/**
 * Non-mutating bounded JSONL reader.
 *
 * Pi's convenience loaders are deliberately not used: `getDefaultSessionDir()`
 * creates directories, `loadEntriesFromFile()` appends a trailing newline and
 * the loader migrations rewrite session files. This reader only opens an
 * existing file for reading, never creates, appends, rewrites, moves, restores
 * or migrates anything, and it enforces shared byte/line/entry/deadline
 * budgets while streaming.
 */

const READ_CHUNK_BYTES = 64 * 1024;

export interface PiSessionReadBudget {
  readonly maxTotalBytes: number;
  readonly maxLineBytes: number;
  readonly maxEntries: number;
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  /** Shared mutable consumption across all files in one observation. */
  usedBytes: number;
  usedEntries: number;
}

export interface PiSessionFileRead {
  readonly status: "supported" | "unsupported" | "malformed" | "unreadable" | "budget" | "aborted";
  readonly header?: PiSessionHeader;
  readonly headerId?: string;
  readonly formatVersion?: number;
  readonly records: readonly PiSessionUsageRecord[];
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
  readonly bytesRead: number;
  readonly entriesRead: number;
  /** True only when the whole supported file was read within budget. */
  readonly complete: boolean;
}

export function createPiSessionReadBudget(options: {
  readonly maxTotalBytes: number;
  readonly maxLineBytes: number;
  readonly maxEntries: number;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}): PiSessionReadBudget {
  return {
    maxTotalBytes: options.maxTotalBytes,
    maxLineBytes: options.maxLineBytes,
    maxEntries: options.maxEntries,
    deadlineAt: Date.now() + options.deadlineMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    usedBytes: 0,
    usedEntries: 0,
  };
}

function isAborted(budget: PiSessionReadBudget): boolean {
  return budget.signal?.aborted === true;
}

function isPastDeadline(budget: PiSessionReadBudget): boolean {
  return Date.now() >= budget.deadlineAt;
}

function diagnostic(
  code: ProviderEvidenceDiagnostic["code"],
  message: string,
): ProviderEvidenceDiagnostic {
  return { code, message };
}

interface BoundedLine {
  readonly text: string;
}

/**
 * Yield complete lines while enforcing a per-line byte cap. Oversized lines
 * are drained and reported, never allocated without bound.
 */
async function* readBoundedLines(
  handle: FileHandle,
  budget: PiSessionReadBudget,
  onOversizedLine: () => void,
): AsyncGenerator<BoundedLine> {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discardingOversizedLine = false;

  function emitPending(): BoundedLine | undefined {
    if (pendingBytes === 0) return undefined;
    const buffer = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    let end = buffer.length;
    if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
    return { text: buffer.subarray(0, end).toString("utf8") };
  }

  while (true) {
    if (isAborted(budget)) return;
    if (isPastDeadline(budget)) return;
    const remaining = budget.maxTotalBytes - budget.usedBytes;
    if (remaining <= 0) return;

    const readSize = Math.min(chunk.length, remaining);
    const { bytesRead } = await handle.read(chunk, 0, readSize, null);
    if (bytesRead === 0) break;
    budget.usedBytes += bytesRead;

    let start = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      if (discardingOversizedLine) {
        discardingOversizedLine = false;
      } else {
        const piece = chunk.subarray(start, index);
        pending.push(Buffer.from(piece));
        pendingBytes += piece.length;
        if (pendingBytes > budget.maxLineBytes) {
          discardingOversizedLine = true;
          pending = [];
          pendingBytes = 0;
          onOversizedLine();
        } else {
          const line = emitPending();
          if (line !== undefined) yield line;
        }
      }
      start = index + 1;
    }

    if (start < bytesRead && !discardingOversizedLine) {
      const piece = chunk.subarray(start, bytesRead);
      pending.push(Buffer.from(piece));
      pendingBytes += piece.length;
      if (pendingBytes > budget.maxLineBytes) {
        discardingOversizedLine = true;
        pending = [];
        pendingBytes = 0;
        onOversizedLine();
      }
    }
  }

  if (!discardingOversizedLine) {
    const line = emitPending();
    if (line !== undefined) yield line;
  }
}

function parseJsonLine(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Read one Pi session file. The caller is responsible for resolving the path
 * against an authorized, canonical root before calling this function.
 */
export async function readPiSessionFile(
  filePath: string,
  budget: PiSessionReadBudget,
): Promise<PiSessionFileRead> {
  if (isAborted(budget)) {
    return {
      status: "aborted",
      records: [],
      diagnostics: [diagnostic("aborted", "session read was cancelled")],
      bytesRead: 0,
      entriesRead: 0,
      complete: false,
    };
  }
  if (isPastDeadline(budget)) {
    return {
      status: "budget",
      records: [],
      diagnostics: [diagnostic("timeout", "session read deadline reached")],
      bytesRead: 0,
      entriesRead: 0,
      complete: false,
    };
  }

  const startUsedBytes = budget.usedBytes;
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return {
      status: "unreadable",
      records: [],
      diagnostics: [diagnostic("unreadable-source", "session file could not be opened")],
      bytesRead: 0,
      entriesRead: 0,
      complete: false,
    };
  }

  let initialFileSize = 0;
  try {
    initialFileSize = (await handle.stat()).size;
  } catch {
    await handle.close().catch(() => undefined);
    return {
      status: "unreadable",
      records: [],
      diagnostics: [diagnostic("unreadable-source", "session file size could not be read")],
      bytesRead: 0,
      entriesRead: 0,
      complete: false,
    };
  }
  const bytesAvailableAtStart = budget.maxTotalBytes - startUsedBytes;
  const truncatedByBudget = initialFileSize > bytesAvailableAtStart;

  const diagnostics: ProviderEvidenceDiagnostic[] = [];
  const records: PiSessionUsageRecord[] = [];
  let header: PiSessionHeader | undefined;
  let headerId: string | undefined;
  let formatVersion: number | undefined;
  let bytesRead = 0;
  let entriesRead = 0;
  let sourceComplete = true;
  let stoppedForBudget = false;

  try {
    let oversizedLine = false;
    const lines = readBoundedLines(handle, budget, () => {
      oversizedLine = true;
      diagnostics.push(
        diagnostic("budget-exceeded", "a session line exceeded the configured line byte limit"),
      );
    });

    for await (const line of lines) {
      if (isAborted(budget)) {
        diagnostics.push(diagnostic("aborted", "session read was cancelled"));
        sourceComplete = false;
        break;
      }
      if (isPastDeadline(budget)) {
        diagnostics.push(diagnostic("timeout", "session read deadline reached"));
        sourceComplete = false;
        stoppedForBudget = true;
        break;
      }
      if (line.text.trim().length === 0) continue;

      if (header === undefined && headerId === undefined) {
        const parsed = parseJsonLine(line.text);
        if (parsed === undefined) {
          diagnostics.push(
            diagnostic("malformed-record", "a session line before the header was not valid JSON"),
          );
          sourceComplete = false;
          continue;
        }
        const headerParse = parsePiSessionHeader(parsed);
        if (headerParse.status === "malformed") {
          diagnostics.push(...headerParse.diagnostics);
          return {
            status: "malformed",
            records,
            diagnostics: dedupeDiagnostics(diagnostics),
            bytesRead: budget.usedBytes - startUsedBytes,
            entriesRead,
            complete: false,
          };
        }
        if (headerParse.status === "unsupported") {
          return {
            status: "unsupported",
            ...(headerParse.headerId === undefined ? {} : { headerId: headerParse.headerId }),
            formatVersion: headerParse.formatVersion,
            records: [],
            diagnostics: dedupeDiagnostics([...diagnostics, ...headerParse.diagnostics]),
            bytesRead: budget.usedBytes - startUsedBytes,
            entriesRead,
            complete: false,
          };
        }
        header = headerParse.header;
        headerId = header.id;
        formatVersion = header.formatVersion;
        entriesRead += 1;
        budget.usedEntries += 1;
        if (budget.usedEntries >= budget.maxEntries) {
          diagnostics.push(
            diagnostic("budget-exceeded", "session entry limit reached before the file ended"),
          );
          sourceComplete = false;
          stoppedForBudget = true;
          break;
        }
        continue;
      }

      if (budget.usedEntries >= budget.maxEntries) {
        diagnostics.push(diagnostic("budget-exceeded", "session entry limit reached"));
        sourceComplete = false;
        stoppedForBudget = true;
        break;
      }

      const parsed = parseJsonLine(line.text);
      if (parsed === undefined) {
        diagnostics.push(diagnostic("malformed-record", "a session line was not valid JSON"));
        sourceComplete = false;
        continue;
      }
      const recordParse = parsePiSessionRecord(parsed);
      entriesRead += 1;
      budget.usedEntries += 1;
      if (recordParse.status === "malformed") {
        diagnostics.push(...recordParse.diagnostics);
        sourceComplete = false;
        continue;
      }
      if (recordParse.status === "usage") {
        records.push(recordParse.record);
      }
    }

    if (oversizedLine) sourceComplete = false;
    const fileBytesRead = budget.usedBytes - startUsedBytes;
    if (isAborted(budget)) {
      sourceComplete = false;
      diagnostics.push(diagnostic("aborted", "session read was cancelled"));
    } else if (isPastDeadline(budget) && fileBytesRead < initialFileSize) {
      stoppedForBudget = true;
      sourceComplete = false;
      diagnostics.push(diagnostic("timeout", "session read deadline reached"));
    } else if (truncatedByBudget || fileBytesRead < initialFileSize) {
      stoppedForBudget = true;
      sourceComplete = false;
      diagnostics.push(
        diagnostic("budget-exceeded", "session read stopped at the configured byte limit"),
      );
    }
  } catch {
    return {
      status: "unreadable",
      ...(header === undefined ? {} : { header }),
      ...(headerId === undefined ? {} : { headerId }),
      ...(formatVersion === undefined ? {} : { formatVersion }),
      records,
      diagnostics: dedupeDiagnostics([
        ...diagnostics,
        diagnostic("unreadable-source", "session file could not be read"),
      ]),
      bytesRead: budget.usedBytes - startUsedBytes,
      entriesRead,
      complete: false,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }

  bytesRead = budget.usedBytes - startUsedBytes;

  if (header === undefined) {
    return {
      status: "malformed",
      records: [],
      diagnostics: dedupeDiagnostics([
        ...diagnostics,
        diagnostic("malformed-record", "session file has no valid Pi session header"),
      ]),
      bytesRead,
      entriesRead,
      complete: false,
    };
  }

  return {
    status: stoppedForBudget ? "budget" : "supported",
    header,
    ...(headerId === undefined ? {} : { headerId }),
    ...(formatVersion === undefined ? {} : { formatVersion }),
    records,
    diagnostics: dedupeDiagnostics(diagnostics),
    bytesRead,
    entriesRead,
    complete: sourceComplete && !stoppedForBudget,
  };
}

function dedupeDiagnostics(
  diagnostics: readonly ProviderEvidenceDiagnostic[],
): readonly ProviderEvidenceDiagnostic[] {
  const seen = new Set<string>();
  const result: ProviderEvidenceDiagnostic[] = [];
  for (const entry of diagnostics) {
    const key = `${entry.code}\u0000${entry.message ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length === 16) break;
  }
  return result;
}
