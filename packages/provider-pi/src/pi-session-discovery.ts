import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { ProviderEvidenceDiagnostic } from "@trailstep/core";

import type { PiSessionUsageRecord } from "./pi-session-format.js";
import {
  createPiSessionReadBudget,
  type PiSessionReadBudget,
  readPiSessionFile,
} from "./pi-session-reader.js";

/**
 * Authorized-root discovery.
 *
 * Roots are canonicalized with `realpath`, the canonical subtree is the only
 * readable surface, and every descendant is re-canonicalized before use so a
 * symlink or `..` escape is rejected. Matching uses the session header `id`,
 * never the filename; a session moved within an authorized root is therefore
 * still discoverable.
 */

const MAX_WALK_DEPTH = 16;

export interface PiSessionDiscoveryLimits {
  readonly maxFiles: number;
  readonly maxSessions: number;
  readonly maxTotalBytes: number;
  readonly maxLineBytes: number;
  readonly maxEntries: number;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

export interface PiDiscoveredSession {
  readonly sessionId: string;
  readonly formatVersion: number;
  readonly supported: boolean;
  /** Canonical path used only inside this process; never serialize it. */
  readonly filePath: string;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly records: readonly PiSessionUsageRecord[];
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
  readonly complete: boolean;
}

export interface PiSessionDiscoveryResult {
  readonly sessions: readonly PiDiscoveredSession[];
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
  readonly filesScanned: number;
  readonly filesRejected: number;
  readonly complete: boolean;
}

function diagnostic(
  code: ProviderEvidenceDiagnostic["code"],
  message: string,
): ProviderEvidenceDiagnostic {
  return { code, message };
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  if (relativePath === "") return true;
  if (isAbsolute(relativePath)) return false;
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface CandidateFile {
  readonly path: string;
}

async function collectCandidateFiles(
  root: string,
  limits: PiSessionDiscoveryLimits,
  deadlineAt: number,
  diagnostics: ProviderEvidenceDiagnostic[],
): Promise<{ files: CandidateFile[]; rejected: number; complete: boolean }> {
  const files: CandidateFile[] = [];
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();
  let rejected = 0;
  let complete = true;

  async function walk(directory: string, depth: number): Promise<void> {
    if (isAborted(limits.signal)) {
      diagnostics.push(diagnostic("aborted", "session discovery was cancelled"));
      complete = false;
      return;
    }
    if (Date.now() >= deadlineAt) {
      diagnostics.push(diagnostic("timeout", "session discovery deadline reached"));
      complete = false;
      return;
    }
    if (depth > MAX_WALK_DEPTH) {
      diagnostics.push(diagnostic("budget-exceeded", "session directory depth limit reached"));
      complete = false;
      return;
    }
    if (visitedDirectories.has(directory)) return;
    visitedDirectories.add(directory);

    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
      diagnostics.push(diagnostic("unreadable-source", "session directory could not be read"));
      complete = false;
      return;
    }

    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= limits.maxFiles) {
        diagnostics.push(diagnostic("budget-exceeded", "session file limit reached"));
        complete = false;
        return;
      }
      if (isAborted(limits.signal)) {
        diagnostics.push(diagnostic("aborted", "session discovery was cancelled"));
        complete = false;
        return;
      }
      const entryPath = join(directory, entry.name);
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(entryPath);
      } catch {
        diagnostics.push(diagnostic("unreadable-source", "session path could not be resolved"));
        complete = false;
        continue;
      }
      if (!isInsideRoot(root, canonicalPath)) {
        rejected += 1;
        diagnostics.push(
          diagnostic("permission-denied", "session path escaped its authorized root"),
        );
        complete = false;
        continue;
      }

      let entryStats: Awaited<ReturnType<typeof stat>>;
      try {
        entryStats = await stat(canonicalPath);
      } catch {
        diagnostics.push(diagnostic("unreadable-source", "session path could not be inspected"));
        complete = false;
        continue;
      }

      if (entryStats.isDirectory()) {
        await walk(canonicalPath, depth + 1);
        continue;
      }
      if (!entryStats.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (visitedFiles.has(canonicalPath)) continue;
      visitedFiles.add(canonicalPath);
      files.push({ path: canonicalPath });
    }
  }

  await walk(root, 0);
  return { files, rejected, complete };
}

export async function discoverPiSessions(
  providerRoots: readonly string[],
  limits: PiSessionDiscoveryLimits,
): Promise<PiSessionDiscoveryResult> {
  const diagnostics: ProviderEvidenceDiagnostic[] = [];
  const canonicalRoots: string[] = [];
  let rootComplete = true;

  for (const root of providerRoots) {
    if (isAborted(limits.signal)) {
      diagnostics.push(diagnostic("aborted", "session discovery was cancelled"));
      rootComplete = false;
      break;
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
      const stats = await stat(canonicalRoot);
      if (!stats.isDirectory() && !stats.isFile()) {
        diagnostics.push(
          diagnostic("unsupported-source", "provider root is not a file or directory"),
        );
        rootComplete = false;
        continue;
      }
      if (stats.isFile() && !canonicalRoot.endsWith(".jsonl")) {
        diagnostics.push(diagnostic("unsupported-source", "provider root file is not JSONL"));
        rootComplete = false;
        continue;
      }
    } catch {
      diagnostics.push(diagnostic("unreadable-source", "provider root could not be resolved"));
      rootComplete = false;
      continue;
    }
    if (!canonicalRoots.includes(canonicalRoot)) canonicalRoots.push(canonicalRoot);
  }

  if (canonicalRoots.length === 0) {
    return {
      sessions: [],
      diagnostics: dedupeDiagnostics([
        ...diagnostics,
        diagnostic("missing-provider-roots", "no authorized provider root was readable"),
      ]),
      filesScanned: 0,
      filesRejected: 0,
      complete: false,
    };
  }

  const deadlineAt = Date.now() + limits.deadlineMs;
  const candidateFiles: string[] = [];
  let filesRejected = 0;
  let candidatesComplete = rootComplete;
  for (const root of canonicalRoots) {
    let rootStats: Awaited<ReturnType<typeof stat>>;
    try {
      rootStats = await stat(root);
    } catch {
      diagnostics.push(diagnostic("unreadable-source", "provider root could not be inspected"));
      candidatesComplete = false;
      continue;
    }
    if (rootStats.isFile()) {
      candidateFiles.push(root);
      continue;
    }
    const collected = await collectCandidateFiles(root, limits, deadlineAt, diagnostics);
    candidateFiles.push(...collected.files.map((file) => file.path));
    filesRejected += collected.rejected;
    candidatesComplete = candidatesComplete && collected.complete;
  }

  const budget: PiSessionReadBudget = createPiSessionReadBudget({
    maxTotalBytes: limits.maxTotalBytes,
    maxLineBytes: limits.maxLineBytes,
    maxEntries: limits.maxEntries,
    deadlineMs: Math.max(1, Math.min(limits.deadlineMs, 600_000)),
    ...(limits.signal === undefined ? {} : { signal: limits.signal }),
  });

  const sessions: PiDiscoveredSession[] = [];
  const seenSessionIds = new Set<string>();
  const seenFiles = new Set<string>();
  let filesScanned = 0;
  let discoveryComplete = candidatesComplete;

  for (const filePath of candidateFiles) {
    if (seenFiles.has(filePath)) continue;
    seenFiles.add(filePath);
    if (filesScanned >= limits.maxFiles) {
      diagnostics.push(diagnostic("budget-exceeded", "session file limit reached"));
      discoveryComplete = false;
      break;
    }
    if (seenSessionIds.size >= limits.maxSessions) {
      diagnostics.push(diagnostic("budget-exceeded", "session limit reached"));
      discoveryComplete = false;
      break;
    }
    if (isAborted(limits.signal)) {
      diagnostics.push(diagnostic("aborted", "session discovery was cancelled"));
      discoveryComplete = false;
      break;
    }
    if (Date.now() >= budget.deadlineAt) {
      diagnostics.push(diagnostic("timeout", "session discovery deadline reached"));
      discoveryComplete = false;
      break;
    }

    filesScanned += 1;
    const read = await readPiSessionFile(filePath, budget);
    diagnostics.push(...read.diagnostics);
    if (!read.complete) discoveryComplete = false;

    const sessionId = read.header?.id ?? read.headerId;
    if (sessionId === undefined) continue;

    if (!seenSessionIds.has(sessionId)) {
      if (seenSessionIds.size >= limits.maxSessions) {
        diagnostics.push(diagnostic("budget-exceeded", "session limit reached"));
        discoveryComplete = false;
        break;
      }
      seenSessionIds.add(sessionId);
    }

    sessions.push({
      sessionId,
      formatVersion: read.formatVersion ?? read.header?.formatVersion ?? 0,
      supported: read.header !== undefined,
      filePath,
      ...(read.header?.cwd === undefined ? {} : { cwd: read.header.cwd }),
      ...(read.header?.parentSession === undefined
        ? {}
        : { parentSession: read.header.parentSession }),
      records: read.records,
      diagnostics: read.diagnostics,
      complete: read.complete,
    });
  }

  return {
    sessions,
    diagnostics: dedupeDiagnostics(diagnostics),
    filesScanned,
    filesRejected,
    complete: discoveryComplete && !isAborted(limits.signal),
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
