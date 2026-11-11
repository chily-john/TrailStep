import type { Event } from "../events/event.types.js";
import type {
  EvidenceCoverage,
  EvidenceDiagnostic,
  EvidenceExecutionState,
  EvidenceProjectIdentity,
  EvidenceSourceRef,
  EvidenceStorageLocation,
  RunEvidence,
  RunEvidenceRunRef,
} from "./evidence.types.js";

/**
 * Bounded read-only evidence query contract (A4a).
 *
 * The query surface is deliberately a library seam: no CLI, no observer and no
 * materialized index live here. Every read is capped by an explicit byte,
 * event, and deadline budget, and the only mutation the module can perform is
 * none at all. Archive reads are expressed through
 * {@link EvidenceArchiveReader}; the default reader is intentionally absent in
 * A4a so this slice can define the contract without changing the archive
 * format or implementing decompression.
 */

/**
 * Projector revision for the A4a query projection. It is independent of
 * `schemaVersion`, which stays `1`; `stale-owner` is additive.
 */
export const RUN_EVIDENCE_QUERY_PROJECTOR_REVISION = "2" as const;

export interface EvidenceQueryLimits {
  /** Maximum run directories/manifests examined by one list call. */
  readonly maxRuns: number;
  /** Maximum event lines parsed per run before the scan is partial. */
  readonly maxEventsPerRun: number;
  /** Maximum bytes read from one `events.jsonl` before the scan is partial. */
  readonly maxEventBytesPerRun: number;
  /** Maximum bytes for one event line; a longer line aborts the bounded scan. */
  readonly maxLineBytes: number;
  /** Maximum bytes read from a small metadata file (`track.json`, manifest). */
  readonly maxTrackBytes: number;
  /** Maximum bytes returned in one evidence excerpt. */
  readonly maxExcerptBytes: number;
  /** Cooperative wall-clock budget for the whole query call. */
  readonly deadlineMs: number;
}

export const DEFAULT_EVIDENCE_QUERY_LIMITS: EvidenceQueryLimits = {
  maxRuns: 200,
  maxEventsPerRun: 20_000,
  maxEventBytesPerRun: 16 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxTrackBytes: 256 * 1024,
  maxExcerptBytes: 8 * 1024,
  deadlineMs: 2_000,
};

/**
 * Query location. `runsRoot` is used verbatim by callers that already resolved
 * it (CLI/MCP), while `cwd` is a convenience for library callers and resolves
 * to `<cwd>/.trailstep/runs`.
 */
export type EvidenceQueryLocation =
  | { readonly runsRoot: string; readonly cwd?: undefined }
  | { readonly cwd: string; readonly runsRoot?: undefined };

export type EvidenceQueryContext = EvidenceQueryLocation & {
  /**
   * Scoped project identity. Core never infers identity from a Git remote,
   * global configuration, or directory basename.
   */
  readonly project: EvidenceProjectIdentity;
  readonly limits?: Partial<EvidenceQueryLimits>;
  /** Cooperative cancellation. A cancelled query returns budget diagnostics, never a partial success. */
  readonly signal?: AbortSignal;
  /** Test seam; defaults to `new Date()`. */
  readonly now?: () => Date;
  /** Optional archive seam. A4a does not ship an implementation. */
  readonly archive?: EvidenceArchiveReader;
};

export type ListRunEvidenceOptions = EvidenceQueryContext & {
  readonly state?: readonly EvidenceExecutionState[];
  readonly workflowId?: string;
  /** Inclusive lower bound on the newest observed run timestamp (ISO). */
  readonly since?: string;
  /** Inclusive upper bound on the newest observed run timestamp (ISO). */
  readonly until?: string;
  /** Maximum returned entries after filtering; default `maxRuns`. */
  readonly limit?: number;
  /** Archived manifests are included by default. Never decompresses in A4a. */
  readonly includeArchived?: boolean;
};

export interface RunEvidenceListResult {
  readonly entries: readonly RunEvidence[];
  readonly coverage: EvidenceCoverage;
  readonly diagnostics: readonly EvidenceDiagnostic[];
  /** Hot run directories and archive manifests examined. */
  readonly scannedRuns: number;
  readonly archivedRuns: number;
  /** Actual bytes read from event trails and metadata files. */
  readonly bytesRead: number;
  /** True when a run/limit/event/deadline budget stopped the listing early. */
  readonly truncated: boolean;
}

export interface EvidencePendingWait {
  readonly waitId: string;
  readonly stepId?: string;
  readonly branchId: string;
  readonly kind?: string;
  readonly answerFile?: string;
}

/**
 * Default-DTO failure summary. The failure message is deliberately omitted:
 * callers that need a bounded, redacted excerpt must ask `retrieveEvidence`
 * for the specific event instead of receiving it in every inspection.
 */
export interface EvidenceFailureSummary {
  readonly eventType: string;
  readonly stepId?: string;
  readonly code?: string;
  readonly summary: string;
}

export interface RunEvidenceInspection {
  readonly status: "found" | "not-found";
  readonly evidence?: RunEvidence;
  readonly lastTimestamp?: string;
  readonly pendingWaits: readonly EvidencePendingWait[];
  readonly failure?: EvidenceFailureSummary;
  readonly terminalEventId?: string;
  readonly trackStatus?: string;
  readonly diagnostics: readonly EvidenceDiagnostic[];
}

export type InspectRunEvidenceOptions = EvidenceQueryContext & {
  readonly runId: string;
};

export type ResolveSourceLinkSelector =
  | { readonly artifactPath: string; readonly eventId?: undefined }
  | { readonly eventId: string; readonly artifactPath?: undefined };

export type ResolveSourceLinkOptions = ResolveSourceLinkSelector & {
  readonly runsRoot: string;
  /** The already-observed run identity. Reusing it keeps the link stable across archive. */
  readonly run: RunEvidenceRunRef;
  readonly limits?: Partial<EvidenceQueryLimits>;
  readonly signal?: AbortSignal;
};

export interface ResolvedEvidenceSourceLink {
  readonly sourceRef: EvidenceSourceRef;
  readonly storage: EvidenceStorageLocation;
  readonly exists: boolean;
  readonly coverage: EvidenceCoverage;
  readonly diagnostics: readonly EvidenceDiagnostic[];
}

export interface RetrieveEvidenceOptions {
  readonly runsRoot: string;
  /** Stable source reference; never a raw path into hot or archived storage. */
  readonly sourceRef: EvidenceSourceRef;
  readonly limits?: Partial<EvidenceQueryLimits>;
  readonly signal?: AbortSignal;
  /** Required only for archived sources; A4b supplies the implementation. */
  readonly archive?: EvidenceArchiveReader;
}

export type RetrieveEvidenceResult =
  | {
      readonly status: "ok";
      readonly sourceRef: EvidenceSourceRef;
      readonly storage: "hot" | "archived";
      readonly mediaType: "application/json" | "text/plain";
      readonly excerpt: string;
      readonly truncated: boolean;
      readonly redacted: boolean;
      readonly bytesRead: number;
      readonly diagnostics: readonly EvidenceDiagnostic[];
    }
  | {
      readonly status: "unavailable";
      readonly sourceRef: EvidenceSourceRef;
      readonly storage: EvidenceStorageLocation;
      readonly diagnostics: readonly EvidenceDiagnostic[];
    };

/**
 * Archive read seam (A4b). Signatures are fixed now so every caller is
 * archive-aware before the implementation lands.
 *
 * Contract notes for A4b:
 * - The archive payload is the documented whole-payload JSON-gzip object
 *   (`{manifest, files[]}`) written by storage lifecycle; do not change the
 *   format. A `stat` on the `.gz` file provides the byte guard before opening.
 * - Archived `workflow.started` events are the source of `startedEventId` and
 *   `identityQuality`; A4a manifest-only projections cannot reconstruct them.
 * - Readers must never restore, rewrite, remove, pin or recreate a run.
 */
export interface ReadArchivedRunEventsRequest {
  readonly runsRoot: string;
  readonly runId: string;
  readonly limits: EvidenceQueryLimits;
  readonly signal?: AbortSignal;
}

export interface ReadArchivedRunEventsResult {
  readonly status: "ok" | "unavailable";
  readonly runId: string;
  readonly events: readonly Event[];
  readonly coverage: EvidenceCoverage;
  readonly diagnostics: readonly EvidenceDiagnostic[];
}

export interface ReadArchivedArtifactRequest {
  readonly runsRoot: string;
  readonly runId: string;
  readonly artifactPath: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface ReadArchivedArtifactResult {
  readonly status: "ok" | "unavailable";
  readonly runId: string;
  readonly artifactPath: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly coverage: EvidenceCoverage;
  readonly diagnostics: readonly EvidenceDiagnostic[];
}

export type ReadArchivedRunEvents = (
  request: ReadArchivedRunEventsRequest,
) => Promise<ReadArchivedRunEventsResult>;

export type ReadArchivedArtifact = (
  request: ReadArchivedArtifactRequest,
) => Promise<ReadArchivedArtifactResult>;

export interface EvidenceArchiveReader {
  readonly readArchivedRunEvents: ReadArchivedRunEvents;
  readonly readArchivedArtifact: ReadArchivedArtifact;
}
