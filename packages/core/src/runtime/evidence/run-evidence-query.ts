import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Event } from "../../contracts/events/event.types.js";
import { isSafeEvidenceArtifactPath } from "../../contracts/evidence/evidence.schema.js";
import type {
  EvidenceCoverage,
  EvidenceDiagnostic,
  EvidenceExecutionState,
  EvidenceIdentityQuality,
  EvidenceProjectIdentity,
  EvidenceSourceRef,
  EvidenceStorageLocation,
  RunEvidence,
  RunEvidenceRunRef,
} from "../../contracts/evidence/evidence.types.js";
import {
  RUN_EVIDENCE_KIND,
  RUN_EVIDENCE_SCHEMA_VERSION,
} from "../../contracts/evidence/evidence.types.js";
import {
  DEFAULT_EVIDENCE_QUERY_LIMITS,
  type EvidenceArchiveReader,
  type EvidenceFailureSummary,
  type EvidencePendingWait,
  type EvidenceQueryContext,
  type EvidenceQueryLimits,
  type InspectRunEvidenceOptions,
  type ListRunEvidenceOptions,
  type ResolvedEvidenceSourceLink,
  type ResolveSourceLinkOptions,
  type RetrieveEvidenceOptions,
  type RetrieveEvidenceResult,
  RUN_EVIDENCE_QUERY_PROJECTOR_REVISION,
  type RunEvidenceInspection,
  type RunEvidenceListResult,
} from "../../contracts/evidence/run-evidence-query.types.js";
import { isNodeError, isPlainObject } from "../../json/guards.js";
import { readWaitAnswerFile, waitEventBranchId } from "../../runs/wait-events.js";
import { defaultRunsRoot, isReservedRunsRootEntry } from "../artifacts/run-storage.js";
import {
  type RunEventsScanResult,
  readBoundedTextFile,
  scanRunEventsBounded,
} from "./bounded-readers.js";
import { classifyRunState, type RunStateClassification } from "./classify-run-state.js";

/**
 * Read-only bounded evidence query surface (A4a).
 *
 * This module intentionally exposes no mutation seam: it uses `stat`,
 * `readdir`, bounded streams, and pure projections only. It never restores,
 * removes, appends to, pins, or recreates a run, and it does not create a
 * materialized index. Archived runs are discovered from their manifests in
 * this slice; payload decompression is deferred to the explicitly versioned
 * `EvidenceArchiveReader` seam implemented in A4b.
 */

const ARCHIVE_DIR = ".archive";
const MAX_DIAGNOSTICS = 16;
const MAX_PENDING_WAITS = 32;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const retainedEventTypes: ReadonlySet<Event["type"]> = new Set([
  "workflow.started",
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
  "workflow.cancelRequested",
  "wait.started",
  "wait.satisfied",
  "wait.failed",
]);

interface InspectedHotRun {
  readonly evidence: RunEvidence;
  readonly classification: RunStateClassification;
  readonly scan: RunEventsScanResult;
  readonly lastTimestamp?: string;
}

interface ArchiveManifestRecord {
  readonly runId: string;
  readonly present: boolean;
  readonly manifest?: {
    readonly status?: string;
    readonly workflowId?: string;
    readonly lastTimestamp?: string;
  };
  readonly diagnostics: readonly EvidenceDiagnostic[];
  readonly bytesRead: number;
}

interface ArchiveManifestListing {
  readonly records: readonly ArchiveManifestRecord[];
  readonly diagnostics: readonly EvidenceDiagnostic[];
  readonly bytesRead: number;
  /** Manifests the discovery loop attempted to read, including malformed ones. */
  readonly examined: number;
  /** True when a run/byte/deadline/abort budget stopped discovery early. */
  readonly truncated: boolean;
}

/** List run evidence envelopes, newest first, under a bounded scan budget. */
export async function listRunEvidence(
  options: ListRunEvidenceOptions,
): Promise<RunEvidenceListResult> {
  const runsRoot = resolveQueryRunsRoot(options);
  const limits = resolveEvidenceQueryLimits(options.limits);
  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const deadline = Date.now() + limits.deadlineMs;
  const diagnostics: EvidenceDiagnostic[] = [];

  const entries: { readonly evidence: RunEvidence; readonly lastTimestamp?: string }[] = [];
  let scannedRuns = 0;
  let archivedRuns = 0;
  let bytesRead = 0;
  let truncated = false;

  let hotEntries: Dirent[];
  try {
    hotEntries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      hotEntries = [];
    } else {
      return {
        entries: [],
        coverage: "unknown",
        diagnostics: [{ code: "unreadable-source", message: "The runs root could not be read." }],
        scannedRuns: 0,
        archivedRuns: 0,
        bytesRead: 0,
        truncated: false,
      };
    }
  }

  for (const entry of hotEntries) {
    if (entry.isDirectory() === false || isReservedRunsRootEntry(entry.name)) {
      continue;
    }
    if (scanBudgetHit({ scannedRuns, limits, deadline, signal: options.signal })) {
      truncated = true;
      pushDiagnostic(diagnostics, {
        code: "budget-exceeded",
        message: "The run listing budget was exceeded before every hot run was examined.",
      });
      break;
    }
    scannedRuns += 1;

    const runId = entry.name;
    try {
      const inspected = await inspectHotRun({
        runDir: join(runsRoot, runId),
        runId,
        project: options.project,
        limits,
        observedAt,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      bytesRead += inspected.scan.bytesRead;
      for (const diagnostic of inspected.scan.diagnostics) {
        if (diagnostic.code === "budget-exceeded") {
          pushDiagnostic(diagnostics, diagnostic);
        }
      }
      if (matchesListFilters(inspected, options)) {
        entries.push({
          evidence: inspected.evidence,
          ...(inspected.lastTimestamp === undefined
            ? {}
            : { lastTimestamp: inspected.lastTimestamp }),
        });
      }
    } catch {
      entries.push({
        evidence: unknownEvidence({
          project: options.project,
          runId,
          storage: "unreadable",
          observedAt,
          diagnostics: [
            {
              code: "unreadable-source",
              message: "The hot run could not be inspected within the query budget.",
            },
          ],
        }),
      });
    }
  }

  if (options.includeArchived !== false) {
    const archived = await listArchivedManifests(runsRoot, limits, {
      remainingRuns: Math.max(0, limits.maxRuns - scannedRuns),
      deadline,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    diagnostics.push(...archived.diagnostics);
    bytesRead += archived.bytesRead;
    if (archived.truncated) {
      truncated = true;
    }
    for (const record of archived.records) {
      if (options.signal?.aborted === true || Date.now() >= deadline) {
        truncated = true;
        pushDiagnostic(diagnostics, {
          code: "budget-exceeded",
          message: "The run listing budget was exceeded before every archived run was examined.",
        });
        break;
      }
      archivedRuns += 1;

      const archivedEntry = await inspectArchivedRecord({
        runsRoot,
        record,
        project: options.project,
        limits,
        observedAt,
        observedAtForManifest: observedAt,
        ...(options.archive === undefined ? {} : { archive: options.archive }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (matchesListFilters(archivedEntry, options)) {
        entries.push({
          evidence: archivedEntry.evidence,
          ...(archivedEntry.lastTimestamp === undefined
            ? {}
            : { lastTimestamp: archivedEntry.lastTimestamp }),
        });
      }
    }
    scannedRuns += archived.examined;
  }

  entries.sort(compareListEntries);

  const limit = Math.max(0, Math.floor(options.limit ?? limits.maxRuns));
  let limited = entries;
  if (entries.length > limit) {
    limited = entries.slice(0, limit);
    truncated = true;
    pushDiagnostic(diagnostics, {
      code: "budget-exceeded",
      message: "The result entry limit was reached; more runs matched the query.",
    });
  }

  const coverage: EvidenceCoverage = truncated
    ? "partial"
    : limited.some((entry) => entry.evidence.execution.coverage !== "complete")
      ? "partial"
      : "complete";

  return {
    entries: limited.map((entry) => entry.evidence),
    coverage,
    diagnostics: boundedDiagnostics(diagnostics),
    scannedRuns,
    archivedRuns,
    bytesRead,
    truncated,
  };
}

/** Inspect one hot or archived run. Never returns raw outputs or transcripts. */
export async function inspectRunEvidence(
  options: InspectRunEvidenceOptions,
): Promise<RunEvidenceInspection> {
  const runsRoot = resolveQueryRunsRoot(options);
  const limits = resolveEvidenceQueryLimits(options.limits);
  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();

  if (RUN_ID_PATTERN.test(options.runId) === false) {
    return {
      status: "not-found",
      pendingWaits: [],
      diagnostics: [
        { code: "malformed-record", message: "The run id is not a safe path segment." },
      ],
    };
  }

  const hotRunDir = join(runsRoot, options.runId);
  if (await isDirectory(hotRunDir)) {
    const inspected = await inspectHotRun({
      runDir: hotRunDir,
      runId: options.runId,
      project: options.project,
      limits,
      observedAt,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const pending = pendingWaitsFromEvents(inspected.classification.pendingWaits);
    const failure = failureSummary(inspected.classification.terminalEvent);
    const diagnostics = boundedDiagnostics([
      ...inspected.evidence.execution.diagnostics,
      ...pending.diagnostics,
    ]);
    return {
      status: "found",
      evidence: {
        ...inspected.evidence,
        execution: {
          ...inspected.evidence.execution,
          coverage:
            pending.truncated ||
            diagnostics.length > inspected.evidence.execution.diagnostics.length
              ? "partial"
              : inspected.evidence.execution.coverage,
          diagnostics,
        },
      },
      ...(inspected.lastTimestamp === undefined ? {} : { lastTimestamp: inspected.lastTimestamp }),
      pendingWaits: pending.waits,
      ...(failure === undefined ? {} : { failure }),
      ...(inspected.classification.terminalEvent === undefined
        ? {}
        : { terminalEventId: inspected.classification.terminalEvent.id }),
      ...(inspected.classification.trackStatus === undefined
        ? {}
        : { trackStatus: inspected.classification.trackStatus }),
      diagnostics,
    };
  }

  const record = await readArchiveManifest(runsRoot, options.runId, limits, options.signal);
  if (record.present === false) {
    return {
      status: "not-found",
      pendingWaits: [],
      diagnostics: [
        {
          code: "missing-source",
          message: "Neither a hot run directory nor an archive manifest exists for this run.",
        },
      ],
    };
  }

  const archived = await inspectArchivedRecord({
    runsRoot,
    record,
    project: options.project,
    limits,
    observedAt,
    observedAtForManifest: observedAt,
    ...(options.archive === undefined ? {} : { archive: options.archive }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const pending = pendingWaitsFromEvents(archived.classification?.pendingWaits ?? []);
  const failure = failureSummary(archived.classification?.terminalEvent);
  const diagnostics = boundedDiagnostics([
    ...archived.evidence.execution.diagnostics,
    ...pending.diagnostics,
  ]);

  return {
    status: "found",
    evidence: {
      ...archived.evidence,
      execution: {
        ...archived.evidence.execution,
        coverage: pending.truncated ? "partial" : archived.evidence.execution.coverage,
        diagnostics,
      },
    },
    ...(archived.lastTimestamp === undefined ? {} : { lastTimestamp: archived.lastTimestamp }),
    pendingWaits: pending.waits,
    ...(failure === undefined ? {} : { failure }),
    ...(archived.classification?.terminalEvent === undefined
      ? {}
      : { terminalEventId: archived.classification.terminalEvent.id }),
    ...(archived.classification?.trackStatus === undefined
      ? {}
      : { trackStatus: archived.classification.trackStatus }),
    diagnostics,
  };
}

/**
 * Resolve a stable source link. The returned reference contains the scoped run
 * identity and exactly one selector; it never contains a path inside a `.gz`
 * archive, so the link survives archiving.
 */
export async function resolveSourceLink(
  options: ResolveSourceLinkOptions,
): Promise<ResolvedEvidenceSourceLink> {
  assertSourceSelector(options.artifactPath, options.eventId);
  const runId = options.run.runId;
  if (RUN_ID_PATTERN.test(runId) === false) {
    throw new TypeError("The source run id is invalid.");
  }
  const runsRoot = resolve(options.runsRoot);
  const limits = resolveEvidenceQueryLimits(options.limits);
  const hotRunDir = join(runsRoot, runId);
  const selector =
    options.artifactPath === undefined
      ? ({ eventId: options.eventId } as const)
      : ({ artifactPath: options.artifactPath } as const);
  const sourceRef: EvidenceSourceRef = { run: options.run, ...selector };

  if (await isDirectory(hotRunDir)) {
    if (options.artifactPath !== undefined) {
      if (isSafeEvidenceArtifactPath(options.artifactPath) === false) {
        throw new TypeError("artifactPath must be a safe run-relative path.");
      }
      try {
        await stat(join(hotRunDir, options.artifactPath));
        return { sourceRef, storage: "hot", exists: true, coverage: "complete", diagnostics: [] };
      } catch (error) {
        return {
          sourceRef,
          storage: "hot",
          exists: false,
          coverage: "unknown",
          diagnostics: [
            isNodeError(error) && error.code === "ENOENT"
              ? { code: "missing-source", message: "The referenced run artifact does not exist." }
              : {
                  code: "unreadable-source",
                  message: "The referenced run artifact is unreadable.",
                },
          ],
        };
      }
    }

    const scan = await scanRunEventsBounded({
      eventsFile: join(hotRunDir, "events.jsonl"),
      maxBytes: limits.maxEventBytesPerRun,
      maxLineBytes: limits.maxLineBytes,
      maxEvents: limits.maxEventsPerRun,
      deadlineMs: limits.deadlineMs,
      retain: (event) => event.id === options.eventId,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const exists = scan.events.some((event) => event.id === options.eventId);
    return {
      sourceRef,
      storage: scan.status === "missing" ? "missing" : "hot",
      exists,
      coverage: scan.coverage,
      diagnostics: boundedDiagnostics([
        ...scan.diagnostics,
        ...(exists || scan.complete === false
          ? []
          : [
              {
                code: "missing-source" as const,
                message: "The referenced event id was not found in the run trail.",
              },
            ]),
      ]),
    };
  }

  const record = await readArchiveManifest(runsRoot, runId, limits, options.signal);
  if (record.present) {
    return {
      sourceRef,
      storage: "archived",
      exists: true,
      coverage: "unknown",
      diagnostics: boundedDiagnostics([
        ...record.diagnostics,
        {
          code: "partial-coverage",
          message:
            "Archive source links are stable; artifact/event existence is verified by archive reads.",
        },
      ]),
    };
  }

  return {
    sourceRef,
    storage: "missing",
    exists: false,
    coverage: "unknown",
    diagnostics: [
      { code: "missing-source", message: "The run does not exist in hot or archive storage." },
    ],
  };
}

/** Retrieve one bounded, redacted, allowlisted excerpt for a stable source ref. */
export async function retrieveEvidence(
  options: RetrieveEvidenceOptions,
): Promise<RetrieveEvidenceResult> {
  const runsRoot = resolve(options.runsRoot);
  const limits = resolveEvidenceQueryLimits(options.limits);
  const sourceRef = options.sourceRef;

  try {
    assertSourceRef(sourceRef);
  } catch {
    return {
      status: "unavailable",
      sourceRef,
      storage: "missing",
      diagnostics: [
        { code: "malformed-record", message: "The evidence source reference is invalid." },
      ],
    };
  }

  const runId = sourceRef.run.runId;
  const hotRunDir = join(runsRoot, runId);
  if (await isDirectory(hotRunDir)) {
    return retrieveHotEvidence({ hotRunDir, sourceRef, limits, options });
  }

  const record = await readArchiveManifest(runsRoot, runId, limits, options.signal);
  if (record.present === false) {
    return {
      status: "unavailable",
      sourceRef,
      storage: "missing",
      diagnostics: [
        { code: "missing-source", message: "The run does not exist in hot or archive storage." },
      ],
    };
  }
  return retrieveArchivedEvidence({ runsRoot, record, sourceRef, limits, options });
}

async function inspectHotRun(options: {
  readonly runDir: string;
  readonly runId: string;
  readonly project: EvidenceProjectIdentity;
  readonly limits: EvidenceQueryLimits;
  readonly observedAt: string;
  readonly signal?: AbortSignal;
}): Promise<InspectedHotRun> {
  const scan = await scanRunEventsBounded({
    eventsFile: join(options.runDir, "events.jsonl"),
    maxBytes: options.limits.maxEventBytesPerRun,
    maxLineBytes: options.limits.maxLineBytes,
    maxEvents: options.limits.maxEventsPerRun,
    deadlineMs: options.limits.deadlineMs,
    retain: (event) => retainedEventTypes.has(event.type),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const classification = await classifyRunState({
    runDir: options.runDir,
    events: scan.events,
    eventsComplete: scan.complete,
    maxTrackBytes: options.limits.maxTrackBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const diagnostics = mergeDiagnostics(scan.diagnostics, classification.diagnostics);
  const coverage = combineCoverage(scan.coverage, diagnostics);
  const evidence = buildEvidence({
    project: options.project,
    runId: options.runId,
    classification,
    storage: "hot",
    coverage,
    diagnostics,
    observedAt: options.observedAt,
  });

  return {
    evidence,
    classification,
    scan,
    ...(scan.lastEvent === undefined ? {} : { lastTimestamp: scan.lastEvent.timestamp }),
  };
}

async function inspectArchivedRecord(options: {
  readonly runsRoot: string;
  readonly record: ArchiveManifestRecord;
  readonly project: EvidenceProjectIdentity;
  readonly limits: EvidenceQueryLimits;
  readonly observedAt: string;
  readonly observedAtForManifest: string;
  readonly archive?: EvidenceArchiveReader;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly evidence: RunEvidence;
  readonly classification?: RunStateClassification;
  readonly lastTimestamp?: string;
}> {
  if (options.archive !== undefined) {
    const read = await options.archive.readArchivedRunEvents({
      runsRoot: options.runsRoot,
      runId: options.record.runId,
      limits: options.limits,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (read.status === "ok") {
      const classification = await classifyRunState({
        runDir: join(options.runsRoot, options.record.runId),
        events: read.events,
        trackSignal: null,
        lock: null,
        eventsComplete: read.coverage === "complete",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const diagnostics = mergeDiagnostics(read.diagnostics, classification.diagnostics);
      const evidence = buildEvidence({
        project: options.project,
        runId: options.record.runId,
        classification,
        storage: "archived",
        coverage: combineCoverage(read.coverage, diagnostics),
        diagnostics,
        observedAt: options.observedAt,
      });
      return {
        evidence,
        classification,
        ...(classification.lastEvent === undefined
          ? {}
          : { lastTimestamp: classification.lastEvent.timestamp }),
      };
    }
    return manifestEvidence(options.record, {
      project: options.project,
      observedAt: options.observedAtForManifest,
      extraDiagnostics: read.diagnostics,
    });
  }

  return manifestEvidence(options.record, {
    project: options.project,
    observedAt: options.observedAtForManifest,
    extraDiagnostics: [],
  });
}

function manifestEvidence(
  record: ArchiveManifestRecord,
  options: {
    readonly project: EvidenceProjectIdentity;
    readonly observedAt: string;
    readonly extraDiagnostics: readonly EvidenceDiagnostic[];
  },
): {
  readonly evidence: RunEvidence;
  readonly classification?: RunStateClassification;
  readonly lastTimestamp?: string;
} {
  const status = record.manifest?.status;
  const state: EvidenceExecutionState =
    status === "completed" || status === "failed" || status === "cancelled" ? status : "unknown";
  const diagnostics = boundedDiagnostics([
    ...record.diagnostics,
    ...options.extraDiagnostics,
    {
      code: "partial-coverage",
      message: "Archived evidence is limited to the manifest until archive reads are implemented.",
    },
  ]);
  const run: RunEvidenceRunRef = {
    project: options.project,
    runId: record.runId,
    identityQuality: "unknown",
    ...(record.manifest?.workflowId === undefined
      ? {}
      : { workflowId: record.manifest.workflowId }),
  };
  return {
    evidence: {
      kind: RUN_EVIDENCE_KIND,
      schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
      observedAt: options.observedAt,
      projectorRevision: RUN_EVIDENCE_QUERY_PROJECTOR_REVISION,
      run,
      execution: {
        state,
        storage: "archived",
        coverage: "unknown",
        diagnostics,
      },
    },
    ...(record.manifest?.lastTimestamp === undefined
      ? {}
      : { lastTimestamp: record.manifest.lastTimestamp }),
  };
}

async function retrieveHotEvidence(options: {
  readonly hotRunDir: string;
  readonly sourceRef: EvidenceSourceRef;
  readonly limits: EvidenceQueryLimits;
  readonly options: RetrieveEvidenceOptions;
}): Promise<RetrieveEvidenceResult> {
  if (options.sourceRef.eventId !== undefined) {
    const scan = await scanRunEventsBounded({
      eventsFile: join(options.hotRunDir, "events.jsonl"),
      maxBytes: options.limits.maxEventBytesPerRun,
      maxLineBytes: options.limits.maxLineBytes,
      maxEvents: options.limits.maxEventsPerRun,
      deadlineMs: options.limits.deadlineMs,
      retain: (event) => event.id === options.sourceRef.eventId,
      ...(options.options.signal === undefined ? {} : { signal: options.options.signal }),
    });
    const event = scan.events.find((candidate) => candidate.id === options.sourceRef.eventId);
    if (event === undefined) {
      return {
        status: "unavailable",
        sourceRef: options.sourceRef,
        storage: scan.status === "missing" ? "missing" : "hot",
        diagnostics: boundedDiagnostics([
          ...scan.diagnostics,
          ...(scan.complete
            ? [
                {
                  code: "missing-source" as const,
                  message: "The referenced event id was not found in the run trail.",
                },
              ]
            : []),
        ]),
      };
    }
    const excerpt = eventExcerpt(event, options.limits.maxExcerptBytes);
    return {
      status: "ok",
      sourceRef: options.sourceRef,
      storage: "hot",
      mediaType: "application/json",
      excerpt: excerpt.text,
      truncated: excerpt.truncated,
      redacted: true,
      bytesRead: scan.bytesRead,
      diagnostics: boundedDiagnostics(scan.diagnostics),
    };
  }

  const artifactPath = options.sourceRef.artifactPath;
  if (artifactPath === undefined) {
    return {
      status: "unavailable",
      sourceRef: options.sourceRef,
      storage: "hot",
      diagnostics: [{ code: "malformed-record", message: "The source reference has no selector." }],
    };
  }

  const access = artifactAccess(artifactPath);
  if (access === "denied") {
    return {
      status: "unavailable",
      sourceRef: options.sourceRef,
      storage: "hot",
      diagnostics: [
        {
          code: "unsupported-source",
          message: "The artifact path is not in the default evidence allowlist.",
        },
      ],
    };
  }

  const read = await readBoundedTextFile(join(options.hotRunDir, artifactPath), {
    maxBytes: options.limits.maxExcerptBytes + 1,
    ...(options.options.signal === undefined ? {} : { signal: options.options.signal }),
  });
  if (read.status !== "ok") {
    return {
      status: "unavailable",
      sourceRef: options.sourceRef,
      storage: read.status === "missing" ? "missing" : "unreadable",
      diagnostics: [
        read.status === "missing"
          ? { code: "missing-source", message: "The referenced run artifact does not exist." }
          : { code: "unreadable-source", message: "The referenced run artifact is unreadable." },
      ],
    };
  }
  if (read.aborted) {
    return {
      status: "unavailable",
      sourceRef: options.sourceRef,
      storage: "hot",
      diagnostics: [{ code: "budget-exceeded", message: "Reading the artifact was aborted." }],
    };
  }

  const sanitized = sanitizeArtifactContent(artifactPath, access, read.text, {
    maxBytes: options.limits.maxExcerptBytes,
    sourceTruncated: read.truncated,
  });
  return {
    status: "ok",
    sourceRef: options.sourceRef,
    storage: "hot",
    mediaType: access === "json" ? "application/json" : "text/plain",
    excerpt: sanitized.text,
    truncated: sanitized.truncated,
    redacted: sanitized.redacted,
    bytesRead: read.bytesRead,
    diagnostics: [],
  };
}

async function retrieveArchivedEvidence(options: {
  readonly runsRoot: string;
  readonly record: ArchiveManifestRecord;
  readonly sourceRef: EvidenceSourceRef;
  readonly limits: EvidenceQueryLimits;
  readonly options: RetrieveEvidenceOptions;
}): Promise<RetrieveEvidenceResult> {
  if (options.options.archive === undefined) {
    return {
      status: "unavailable",
      sourceRef: options.sourceRef,
      storage: "archived",
      diagnostics: [
        {
          code: "unsupported-source",
          message: "Archived evidence retrieval requires the A4b archive reader.",
        },
      ],
    };
  }

  if (options.sourceRef.eventId !== undefined) {
    const read = await options.options.archive.readArchivedRunEvents({
      runsRoot: options.runsRoot,
      runId: options.record.runId,
      limits: options.limits,
      ...(options.options.signal === undefined ? {} : { signal: options.options.signal }),
    });
    if (read.status !== "ok") {
      return {
        status: "unavailable",
        sourceRef: options.sourceRef,
        storage: "archived",
        diagnostics: boundedDiagnostics([...options.record.diagnostics, ...read.diagnostics]),
      };
    }
    const event = read.events.find((candidate) => candidate.id === options.sourceRef.eventId);
    if (event === undefined) {
      return {
        status: "unavailable",
        sourceRef: options.sourceRef,
        storage: "archived",
        diagnostics: [
          {
            code: "missing-source",
            message: "The referenced event id was not found in the archived trail.",
          },
        ],
      };
    }
    const excerpt = eventExcerpt(event, options.limits.maxExcerptBytes);
    return {
      status: "ok",
      sourceRef: options.sourceRef,
      storage: "archived",
      mediaType: "application/json",
      excerpt: excerpt.text,
      truncated: excerpt.truncated,
      redacted: true,
      bytesRead: 0,
      diagnostics: boundedDiagnostics(read.diagnostics),
    };
  }

  const artifactPath = options.sourceRef.artifactPath;
  if (artifactPath === undefined) {
    return {
      status: "unavailable",
      sourceRef: options.sourceRef,
      storage: "archived",
      diagnostics: [{ code: "malformed-record", message: "The source reference has no selector." }],
    };
  }
  const access = artifactAccess(artifactPath);
  if (access === "denied") {
    return {
      status: "unavailable",
      sourceRef: options.sourceRef,
      storage: "archived",
      diagnostics: [
        {
          code: "unsupported-source",
          message: "The artifact path is not in the default evidence allowlist.",
        },
      ],
    };
  }

  const read = await options.options.archive.readArchivedArtifact({
    runsRoot: options.runsRoot,
    runId: options.record.runId,
    artifactPath,
    maxBytes: options.limits.maxExcerptBytes + 1,
    ...(options.options.signal === undefined ? {} : { signal: options.options.signal }),
  });
  if (read.status !== "ok") {
    return {
      status: "unavailable",
      sourceRef: options.sourceRef,
      storage: "archived",
      diagnostics: boundedDiagnostics([...options.record.diagnostics, ...read.diagnostics]),
    };
  }

  const sanitized = sanitizeArtifactContent(artifactPath, access, read.content, {
    maxBytes: options.limits.maxExcerptBytes,
    sourceTruncated: read.truncated,
  });
  return {
    status: "ok",
    sourceRef: options.sourceRef,
    storage: "archived",
    mediaType: access === "json" ? "application/json" : "text/plain",
    excerpt: sanitized.text,
    truncated: sanitized.truncated,
    redacted: sanitized.redacted,
    bytesRead: 0,
    diagnostics: boundedDiagnostics(read.diagnostics),
  };
}

async function listArchivedManifests(
  runsRoot: string,
  limits: EvidenceQueryLimits,
  options: {
    readonly remainingRuns: number;
    readonly deadline: number;
    readonly signal?: AbortSignal;
  },
): Promise<ArchiveManifestListing> {
  const archiveDir = join(runsRoot, ARCHIVE_DIR);
  let entries: Dirent[];
  try {
    entries = await readdir(archiveDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { records: [], diagnostics: [], bytesRead: 0, examined: 0, truncated: false };
    }
    return {
      records: [],
      diagnostics: [
        { code: "unreadable-source", message: "The archive directory could not be read." },
      ],
      bytesRead: 0,
      examined: 0,
      truncated: false,
    };
  }

  const records: ArchiveManifestRecord[] = [];
  const diagnostics: EvidenceDiagnostic[] = [];
  let bytesRead = 0;
  let examined = 0;
  let truncated = false;
  // Each manifest read is separately capped at maxTrackBytes. The pass as a
  // whole is capped by the remaining run allowance, so a small maxRuns cannot
  // still read every manifest first and apply the budget afterwards.
  const byteBudget = options.remainingRuns * limits.maxTrackBytes;

  for (const entry of entries) {
    if (entry.isFile() === false || entry.name.endsWith(".manifest.json") === false) {
      continue;
    }
    const runId = entry.name.slice(0, -".manifest.json".length);
    if (RUN_ID_PATTERN.test(runId) === false) {
      continue;
    }

    const stopReason = archiveDiscoveryStopReason({
      examined,
      remainingRuns: options.remainingRuns,
      bytesRead,
      byteBudget,
      deadline: options.deadline,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (stopReason !== undefined) {
      truncated = true;
      diagnostics.push({
        code: "budget-exceeded",
        message: `Archive manifest discovery stopped: ${stopReason}.`,
      });
      break;
    }

    examined += 1;
    const record = await readArchiveManifest(runsRoot, runId, limits, options.signal);
    bytesRead += record.bytesRead;
    if (record.present) {
      records.push(record);
    }
    if (options.signal?.aborted === true) {
      truncated = true;
      diagnostics.push({
        code: "budget-exceeded",
        message: "Archive manifest discovery stopped: the query was aborted.",
      });
      break;
    }
  }

  return { records, diagnostics, bytesRead, examined, truncated };
}

async function readArchiveManifest(
  runsRoot: string,
  runId: string,
  limits: EvidenceQueryLimits,
  signal?: AbortSignal,
): Promise<ArchiveManifestRecord> {
  if (RUN_ID_PATTERN.test(runId) === false) {
    return {
      runId,
      present: false,
      diagnostics: [{ code: "malformed-record", message: "The archive run id is invalid." }],
      bytesRead: 0,
    };
  }

  const read = await readBoundedTextFile(join(runsRoot, ARCHIVE_DIR, `${runId}.manifest.json`), {
    maxBytes: limits.maxTrackBytes,
    ...(signal === undefined ? {} : { signal }),
  });
  if (read.status === "missing") {
    return { runId, present: false, diagnostics: [], bytesRead: read.bytesRead };
  }
  if (read.status !== "ok" || read.aborted || read.truncated) {
    return {
      runId,
      present: true,
      diagnostics: [
        {
          code: read.aborted ? "budget-exceeded" : "unreadable-source",
          message: "The archive manifest could not be read within the metadata budget.",
        },
      ],
      bytesRead: read.bytesRead,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return {
      runId,
      present: true,
      diagnostics: [
        { code: "malformed-record", message: "The archive manifest is not valid JSON." },
      ],
      bytesRead: read.bytesRead,
    };
  }
  if (isPlainObject(parsed) === false) {
    return {
      runId,
      present: true,
      diagnostics: [
        { code: "malformed-record", message: "The archive manifest is not an object." },
      ],
      bytesRead: read.bytesRead,
    };
  }

  const manifestRunId = typeof parsed.runId === "string" ? parsed.runId : runId;
  if (RUN_ID_PATTERN.test(manifestRunId) === false) {
    return {
      runId,
      present: true,
      diagnostics: [
        { code: "malformed-record", message: "The archive manifest run id is invalid." },
      ],
      bytesRead: read.bytesRead,
    };
  }

  return {
    runId: manifestRunId,
    present: true,
    manifest: {
      ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
      ...(typeof parsed.workflowId === "string" ? { workflowId: parsed.workflowId } : {}),
      ...(typeof parsed.lastTimestamp === "string" ? { lastTimestamp: parsed.lastTimestamp } : {}),
    },
    diagnostics:
      manifestRunId === runId
        ? []
        : [
            {
              code: "changed-source",
              message: "The archive manifest run id does not match its file name.",
            },
          ],
    bytesRead: read.bytesRead,
  };
}

function buildEvidence(options: {
  readonly project: EvidenceProjectIdentity;
  readonly runId: string;
  readonly classification: RunStateClassification;
  readonly storage: EvidenceStorageLocation;
  readonly coverage: EvidenceCoverage;
  readonly diagnostics: readonly EvidenceDiagnostic[];
  readonly observedAt: string;
}): RunEvidence {
  return {
    kind: RUN_EVIDENCE_KIND,
    schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
    observedAt: options.observedAt,
    projectorRevision: RUN_EVIDENCE_QUERY_PROJECTOR_REVISION,
    run: buildRunRef(options.project, options.runId, options.classification, options.storage),
    execution: {
      state: options.classification.state,
      storage: options.storage,
      coverage: options.coverage,
      diagnostics: boundedDiagnostics(options.diagnostics),
    },
  };
}

function buildRunRef(
  project: EvidenceProjectIdentity,
  runId: string,
  classification: RunStateClassification,
  storage: EvidenceStorageLocation,
): RunEvidenceRunRef {
  const startedEventId = classification.startedEventId;
  const identityQuality: EvidenceIdentityQuality =
    startedEventId === undefined
      ? storage === "archived"
        ? "unknown"
        : "legacy-ambiguous"
      : project.kind === "explicit"
        ? "explicit"
        : "local";

  return {
    project,
    runId,
    identityQuality,
    ...(startedEventId === undefined ? {} : { startedEventId }),
    ...(classification.workflowId === undefined ? {} : { workflowId: classification.workflowId }),
  };
}

function unknownEvidence(options: {
  readonly project: EvidenceProjectIdentity;
  readonly runId: string;
  readonly storage: EvidenceStorageLocation;
  readonly observedAt: string;
  readonly diagnostics: readonly EvidenceDiagnostic[];
}): RunEvidence {
  return {
    kind: RUN_EVIDENCE_KIND,
    schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
    observedAt: options.observedAt,
    projectorRevision: RUN_EVIDENCE_QUERY_PROJECTOR_REVISION,
    run: {
      project: options.project,
      runId: options.runId,
      identityQuality: "unknown",
    },
    execution: {
      state: "unknown",
      storage: options.storage,
      coverage: "unknown",
      diagnostics: boundedDiagnostics(options.diagnostics),
    },
  };
}

function combineCoverage(
  scanCoverage: EvidenceCoverage,
  diagnostics: readonly EvidenceDiagnostic[],
): EvidenceCoverage {
  if (scanCoverage === "unknown") {
    return "unknown";
  }
  return scanCoverage === "complete" && diagnostics.length === 0 ? "complete" : "partial";
}

function matchesListFilters(
  entry: {
    readonly evidence: RunEvidence;
    readonly lastTimestamp?: string;
  },
  options: ListRunEvidenceOptions,
): boolean {
  if (
    options.state !== undefined &&
    options.state.includes(entry.evidence.execution.state) === false
  ) {
    return false;
  }
  if (options.workflowId !== undefined && entry.evidence.run.workflowId !== options.workflowId) {
    return false;
  }
  return timestampInRange(entry.lastTimestamp, options.since, options.until);
}

function timestampInRange(
  timestamp: string | undefined,
  since: string | undefined,
  until: string | undefined,
): boolean {
  if (since === undefined && until === undefined) {
    return true;
  }
  if (timestamp === undefined) {
    return false;
  }
  const value = Date.parse(timestamp);
  if (Number.isFinite(value) === false) {
    return false;
  }
  if (since !== undefined) {
    const sinceValue = Date.parse(since);
    if (Number.isFinite(sinceValue) === false || value < sinceValue) {
      return false;
    }
  }
  if (until !== undefined) {
    const untilValue = Date.parse(until);
    if (Number.isFinite(untilValue) === false || value > untilValue) {
      return false;
    }
  }
  return true;
}

function compareListEntries(
  left: { readonly evidence: RunEvidence; readonly lastTimestamp?: string },
  right: { readonly evidence: RunEvidence; readonly lastTimestamp?: string },
): number {
  return (
    compareTimestampDescending(left.lastTimestamp, right.lastTimestamp) ||
    left.evidence.run.runId.localeCompare(right.evidence.run.runId)
  );
}

function compareTimestampDescending(left: string | undefined, right: string | undefined): number {
  const leftTime = left === undefined ? Number.NEGATIVE_INFINITY : Date.parse(left);
  const rightTime = right === undefined ? Number.NEGATIVE_INFINITY : Date.parse(right);
  return (
    (Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY) -
    (Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY)
  );
}

function scanBudgetHit(options: {
  readonly scannedRuns: number;
  readonly limits: EvidenceQueryLimits;
  readonly deadline: number;
  readonly signal?: AbortSignal;
}): boolean {
  return (
    options.scannedRuns >= options.limits.maxRuns ||
    options.signal?.aborted === true ||
    Date.now() >= options.deadline
  );
}

function archiveDiscoveryStopReason(options: {
  readonly examined: number;
  readonly remainingRuns: number;
  readonly bytesRead: number;
  readonly byteBudget: number;
  readonly deadline: number;
  readonly signal?: AbortSignal;
}): string | undefined {
  if (options.signal?.aborted === true) {
    return "the query was aborted";
  }
  if (options.examined >= options.remainingRuns) {
    return "the maxRuns budget was reached";
  }
  if (options.bytesRead >= options.byteBudget) {
    return "the archive manifest byte budget was reached";
  }
  if (Date.now() >= options.deadline) {
    return "the query deadline was exceeded";
  }
  return undefined;
}

function pendingWaitsFromEvents(events: readonly Event[]): {
  readonly waits: readonly EvidencePendingWait[];
  readonly truncated: boolean;
  readonly diagnostics: readonly EvidenceDiagnostic[];
} {
  const waits = events.slice(0, MAX_PENDING_WAITS).map((event) => {
    const waitId = typeof event.payload.waitId === "string" ? event.payload.waitId : "";
    const answerFile = readWaitAnswerFile(event);
    return {
      waitId,
      branchId: waitEventBranchId(event),
      ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      ...(typeof event.payload.kind === "string" ? { kind: event.payload.kind } : {}),
      ...(answerFile === undefined || isSafeEvidenceArtifactPath(answerFile) === false
        ? {}
        : { answerFile }),
    };
  });
  const truncated = events.length > MAX_PENDING_WAITS;
  return {
    waits,
    truncated,
    diagnostics: truncated
      ? [
          {
            code: "budget-exceeded",
            message: "Pending wait details were capped; more waits are pending.",
          },
        ]
      : [],
  };
}

function failureSummary(event: Event | undefined): EvidenceFailureSummary | undefined {
  if (event === undefined || event.type !== "workflow.failed") {
    return undefined;
  }
  const failure = event.payload.failure;
  const code =
    isPlainObject(failure) && typeof failure.code === "string"
      ? truncateText(redactSecrets(failure.code), 128)
      : undefined;
  return {
    eventType: event.type,
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    ...(code === undefined ? {} : { code }),
    summary:
      "Failure message omitted from the default evidence DTO; retrieve its event for an excerpt.",
  };
}

function eventExcerpt(
  event: Event,
  maxBytes: number,
): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const payload: Record<string, unknown> = {};
  for (const key of [
    "branchId",
    "waitId",
    "kind",
    "attempt",
    "maxAttempts",
    "phaseIndex",
    "stepIndex",
    "reasonCode",
  ]) {
    const value = event.payload[key];
    if (typeof value === "string") {
      payload[key] = truncateText(redactSecrets(value), 256);
    } else if (typeof value === "number" || typeof value === "boolean") {
      payload[key] = value;
    }
  }
  if (typeof event.payload.message === "string") {
    payload.message = truncateText(redactSecrets(event.payload.message), 1024);
  }
  const failure = event.payload.failure;
  if (isPlainObject(failure)) {
    payload.failure = {
      ...(typeof failure.code === "string"
        ? { code: truncateText(redactSecrets(failure.code), 128) }
        : {}),
      ...(typeof failure.message === "string"
        ? { message: truncateText(redactSecrets(failure.message), 512) }
        : {}),
    };
  }

  const projection = {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    runId: event.runId,
    workflowId: event.workflowId,
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    payload,
  };
  const json = JSON.stringify(projection, null, 2);
  const text = truncateUtf8(json, maxBytes);
  return { text, truncated: text !== json };
}

type ArtifactAccess = "json" | "text" | "denied";

function artifactAccess(artifactPath: string): ArtifactAccess {
  if (
    artifactPath === "state.json" ||
    artifactPath === "global-state.json" ||
    artifactPath === "track.json"
  ) {
    return "json";
  }
  if (/^branches\/[A-Za-z0-9._-]+\.state\.json$/u.test(artifactPath)) {
    return "json";
  }
  if (/^steps\/[A-Za-z0-9._-]+\/(?:usage|attempts)\.json$/u.test(artifactPath)) {
    return "json";
  }
  if (/^steps\/[A-Za-z0-9._-]+\/session-description\.md$/u.test(artifactPath)) {
    return "text";
  }
  return "denied";
}

function sanitizeArtifactContent(
  artifactPath: string,
  access: Exclude<ArtifactAccess, "denied">,
  content: string,
  options: { readonly maxBytes: number; readonly sourceTruncated: boolean },
): { readonly text: string; readonly truncated: boolean; readonly redacted: boolean } {
  if (access === "json") {
    // Structural deny-key redaction runs on the raw text before parsing or
    // truncation. If the bounded read cut the JSON mid-document, JSON.parse
    // fails; the fallback then reuses this already-redacted text instead of
    // downgrading to regex-only redaction.
    const structurallyRedacted = redactDeniedJsonKeys(content);
    try {
      const parsed: unknown = JSON.parse(structurallyRedacted);
      if (artifactPath === "track.json" && isPlainObject(parsed)) {
        const picked = pickTrackSummary(parsed);
        const json = JSON.stringify(picked, null, 2);
        const text = truncateUtf8(json, options.maxBytes);
        return {
          text,
          truncated: options.sourceTruncated || text !== json,
          redacted: true,
        };
      }
      const sanitized = sanitizeJsonValue(parsed, 0);
      const json = JSON.stringify(sanitized.value, null, 2);
      const text = truncateUtf8(redactSecrets(json), options.maxBytes);
      return {
        text,
        truncated: options.sourceTruncated || text !== json,
        redacted: true,
      };
    } catch {
      // A truncated JSON preview is not parseable; fall through to a redacted
      // text excerpt so the caller still gets a bounded observation.
    }
    const redacted = redactSecrets(structurallyRedacted);
    const text = truncateUtf8(redacted, options.maxBytes);
    return {
      text,
      truncated: options.sourceTruncated || text !== redacted,
      redacted: structurallyRedacted !== content || redacted !== structurallyRedacted,
    };
  }

  const redacted = redactSecrets(content);
  const text = truncateUtf8(redacted, options.maxBytes);
  return {
    text,
    truncated: options.sourceTruncated || text !== redacted,
    redacted: redacted !== content,
  };
}

function pickTrackSummary(track: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of [
    "runId",
    "status",
    "workers",
    "ownerPid",
    "failurePolicy",
    "rootBranchId",
    "terminalBranchId",
    "terminalKind",
    "splitOccurred",
  ]) {
    const value = track[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      picked[key] = value;
    }
  }
  if (Array.isArray(track.branches)) {
    picked.branches = track.branches.slice(0, 32).map((branch) => {
      if (isPlainObject(branch) === false) {
        return {};
      }
      const summary: Record<string, unknown> = {};
      for (const key of [
        "branchId",
        "requestedBranchId",
        "parentBranchId",
        "status",
        "workflowId",
        "latestStepIndex",
        "latestStepId",
      ]) {
        const value = branch[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          summary[key] = value;
        }
      }
      return summary;
    });
  }
  return picked;
}

const DENIED_JSON_KEYS: ReadonlySet<string> = new Set([
  "answer",
  "answers",
  "api-key",
  "api_key",
  "apikey",
  "accesstoken",
  "authorization",
  "content",
  "contents",
  "credential",
  "credentials",
  "env",
  "environment",
  "failure",
  "failures",
  "input",
  "inputs",
  "interactive",
  "message",
  "messages",
  "output",
  "outputs",
  "password",
  "prompt",
  "prompts",
  "question",
  "reason",
  "refresh_token",
  "request",
  "requests",
  "secret",
  "secrets",
  "session",
  "sessions",
  "stderr",
  "stdout",
  "terminal_output",
  "terminaloutput",
  "token",
  "tokens",
  "transcript",
  "transcripts",
  "work",
]);

/**
 * Redact denied object keys from raw JSON text without requiring the document
 * to be complete or parseable. Keys are recognized as JSON string tokens
 * followed (after whitespace) by `:`, so text inside a string value is never
 * mistaken for a key. A denied key's value is skipped as one balanced JSON
 * value; when truncation cuts the value short, everything to the end of the
 * available text is removed. This runs before any size or parse fallback, so
 * a truncated artifact cannot leak a denied value.
 */
function redactDeniedJsonKeys(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char !== '"') {
      output += char;
      index += 1;
      continue;
    }
    const tokenEnd = readJsonStringToken(text, index);
    const token = text.slice(index, tokenEnd);
    let afterToken = tokenEnd;
    while (afterToken < text.length && isJsonWhitespace(text.charAt(afterToken))) {
      afterToken += 1;
    }
    const key = decodeJsonStringToken(token);
    if (
      text.charAt(afterToken) !== ":" ||
      key === undefined ||
      DENIED_JSON_KEYS.has(key.toLowerCase()) === false
    ) {
      output += token;
      index = tokenEnd;
      continue;
    }
    output += text.slice(index, afterToken + 1);
    const valueEnd = findJsonValueEnd(text, afterToken + 1);
    output += ' "[REDACTED]"';
    index = valueEnd;
  }
  return output;
}

/** Return the index just past a JSON string token beginning at `start`. */
function readJsonStringToken(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function decodeJsonStringToken(token: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(token);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Find the end of one JSON value, tolerating a truncated final value. */
function findJsonValueEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length && isJsonWhitespace(text.charAt(index))) {
    index += 1;
  }
  const first = text.charAt(index);
  if (first === '"') {
    return readJsonStringToken(text, index);
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    while (index < text.length) {
      const char = text.charAt(index);
      if (char === '"') {
        index = readJsonStringToken(text, index);
        continue;
      }
      if (char === "{" || char === "[") {
        depth += 1;
      } else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) {
          return index + 1;
        }
      }
      index += 1;
    }
    return text.length;
  }
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "," || char === "}" || char === "]" || isJsonWhitespace(char)) {
      break;
    }
    index += 1;
  }
  return index;
}

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function sanitizeJsonValue(value: unknown, depth: number): { readonly value: unknown } {
  if (depth > 6) {
    return { value: "[depth-limited]" };
  }
  if (typeof value === "string") {
    return { value: truncateText(redactSecrets(value), 512) };
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { value };
  }
  if (Array.isArray(value)) {
    return {
      value: value.slice(0, 50).map((entry) => sanitizeJsonValue(entry, depth + 1).value),
    };
  }
  if (isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= 50) {
        break;
      }
      if (DENIED_JSON_KEYS.has(key.toLowerCase())) {
        continue;
      }
      sanitized[key] = sanitizeJsonValue(entry, depth + 1).value;
      count += 1;
    }
    return { value: sanitized };
  }
  return { value: String(value) };
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]{8,}/gu, "[REDACTED]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{8,}/gu, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/giu,
      "$1[REDACTED]",
    );
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const marker = "\n…[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) {
    return marker.slice(0, Math.max(0, maxBytes));
  }
  let output = "";
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes - markerBytes) {
      break;
    }
    output += char;
    bytes += charBytes;
  }
  return `${output}${marker}`;
}

function boundedDiagnostics(
  diagnostics: readonly EvidenceDiagnostic[],
): readonly EvidenceDiagnostic[] {
  const seen = new Set<string>();
  const result: EvidenceDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.message ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
    if (result.length === MAX_DIAGNOSTICS) {
      break;
    }
  }
  return result;
}

function mergeDiagnostics(
  ...groups: readonly (readonly EvidenceDiagnostic[])[]
): readonly EvidenceDiagnostic[] {
  return boundedDiagnostics(groups.flat());
}

function pushDiagnostic(diagnostics: EvidenceDiagnostic[], diagnostic: EvidenceDiagnostic): void {
  if (
    diagnostics.some(
      (entry) => entry.code === diagnostic.code && entry.message === diagnostic.message,
    )
  ) {
    return;
  }
  if (diagnostics.length < MAX_DIAGNOSTICS) {
    diagnostics.push(diagnostic);
  }
}

function resolveQueryRunsRoot(context: EvidenceQueryContext): string {
  if (context.runsRoot !== undefined) {
    return resolve(context.runsRoot);
  }
  if (context.cwd !== undefined) {
    return defaultRunsRoot(resolve(context.cwd));
  }
  throw new TypeError("Evidence query requires either runsRoot or cwd.");
}

function resolveEvidenceQueryLimits(
  limits: Partial<EvidenceQueryLimits> | undefined,
): EvidenceQueryLimits {
  const pick = (
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
      : fallback;

  return {
    maxRuns: pick(limits?.maxRuns, DEFAULT_EVIDENCE_QUERY_LIMITS.maxRuns, 1, 10_000),
    maxEventsPerRun: pick(
      limits?.maxEventsPerRun,
      DEFAULT_EVIDENCE_QUERY_LIMITS.maxEventsPerRun,
      0,
      1_000_000,
    ),
    maxEventBytesPerRun: pick(
      limits?.maxEventBytesPerRun,
      DEFAULT_EVIDENCE_QUERY_LIMITS.maxEventBytesPerRun,
      0,
      1024 * 1024 * 1024,
    ),
    maxLineBytes: pick(
      limits?.maxLineBytes,
      DEFAULT_EVIDENCE_QUERY_LIMITS.maxLineBytes,
      1,
      128 * 1024 * 1024,
    ),
    maxTrackBytes: pick(
      limits?.maxTrackBytes,
      DEFAULT_EVIDENCE_QUERY_LIMITS.maxTrackBytes,
      1,
      64 * 1024 * 1024,
    ),
    maxExcerptBytes: pick(
      limits?.maxExcerptBytes,
      DEFAULT_EVIDENCE_QUERY_LIMITS.maxExcerptBytes,
      16,
      1024 * 1024,
    ),
    deadlineMs: pick(limits?.deadlineMs, DEFAULT_EVIDENCE_QUERY_LIMITS.deadlineMs, 0, 600_000),
  };
}

function assertSourceSelector(artifactPath: string | undefined, eventId: string | undefined): void {
  if ((artifactPath === undefined) === (eventId === undefined)) {
    throw new TypeError("A source link requires exactly one of artifactPath or eventId.");
  }
  if (artifactPath !== undefined && isSafeEvidenceArtifactPath(artifactPath) === false) {
    throw new TypeError("artifactPath must be a safe run-relative path.");
  }
  if (eventId !== undefined && EVENT_ID_PATTERN.test(eventId) === false) {
    throw new TypeError("eventId must be a safe event identifier.");
  }
}

function assertSourceRef(sourceRef: EvidenceSourceRef): void {
  if (RUN_ID_PATTERN.test(sourceRef.run.runId) === false) {
    throw new TypeError("The source run id is invalid.");
  }
  assertSourceSelector(sourceRef.artifactPath, sourceRef.eventId);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    return false;
  }
}
