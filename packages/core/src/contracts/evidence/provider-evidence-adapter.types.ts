import type { DispatchProvenance } from "../dispatch-provenance/dispatch-provenance.types.js";
import type { PlainObject, ValidationDiagnostic } from "../shapes/shape.types.js";
import type { RunEvidenceRunRef } from "./evidence.types.js";

/**
 * Provider-neutral callable evidence bridge (A3a V1).
 *
 * This module is a leaf contract: adapter implementations (provider packages)
 * import it; core never imports Pi or any concrete provider. It carries a
 * single `readUsage` operation on purpose. A separate `operation` field was
 * dropped during design review: `schemaVersion` is already the forward
 * compatibility axis, and a one-member operation enum would invite readers to
 * branch on a value that can never vary.
 *
 * Version axes:
 * - `schemaVersion` is the wire contract. Unknown values are rejected
 *   explicitly (`unsupported-version`) instead of being treated as empty
 *   evidence.
 * - `adapterRevision` is an optional producer revision, analogous to A1's
 *   `projectorRevision`. Bumping it must stay backward compatible with
 *   schema version 1; changing field meanings requires a new schema version.
 *
 * Read-only, non-mutating adapter contract (explicit, not just a test
 * expectation): `readUsage` must be a pure observation. It must not create,
 * move, delete, migrate, restore, rewrite or append to session files,
 * directories, indexes, caches or configuration. It must resolve every
 * authorized `providerRoots` entry to its real path, treat that canonical
 * subtree as the only readable surface, and reject symlink/realpath escapes
 * even when a path is lexically inside a root. The core invocation helper
 * cannot enforce filesystem behavior; this is a trust contract proved by
 * adapter fixture tests, not a sandbox.
 */

export const PROVIDER_EVIDENCE_REQUEST_KIND = "trailstep.provider-evidence-request" as const;
export const PROVIDER_EVIDENCE_RESPONSE_KIND = "trailstep.provider-usage-evidence" as const;
export const PROVIDER_EVIDENCE_SCHEMA_VERSION = 1 as const;

/** Bounded diagnostic codes. Messages are redacted and never echo input. */
export type ProviderEvidenceDiagnosticCode =
  | "unsupported-version"
  | "malformed-record"
  | "malformed-request"
  | "malformed-response"
  | "malformed-export"
  | "missing-capability"
  | "missing-provider-roots"
  | "identity-mismatch"
  | "unsupported-source"
  | "unreadable-source"
  | "permission-denied"
  | "budget-exceeded"
  | "oversized-response"
  | "timeout"
  | "aborted"
  | "adapter-failed"
  | "ambiguous-identity"
  | "partial-coverage"
  | "changed-source";

export interface ProviderEvidenceDiagnostic {
  readonly code: ProviderEvidenceDiagnosticCode;
  /** Bounded, redacted human message. Must not echo secrets, paths or parser input. */
  readonly message?: string;
}

/**
 * Shared finite limits for one observation. `deadlineMs` and
 * `maxResponseBytes` are also enforced by the core invocation helper; the
 * remaining bounds are enforced cooperatively by the adapter's bounded
 * readers. A timeout stops waiting; it does not prove synchronous work ended.
 */
export interface ProviderEvidenceLimits {
  readonly maxCandidateRuns: number;
  readonly maxSessions: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxLineBytes: number;
  readonly maxEntries: number;
  readonly maxActivities: number;
  readonly maxResponseBytes: number;
  readonly deadlineMs: number;
}

/**
 * Allowlisted A2 dispatch context. `sessionId` is deliberately not an
 * attempt identity; `spawnEventId` is the actual dispatch/spawn anchor.
 */
export type ProviderEvidenceDispatchObservation = Omit<DispatchProvenance, "schemaVersion">;

export interface ProviderEvidenceProviderRef {
  /** Registered package key in TrailStep config. */
  readonly registrationId: string;
  /** Manifest identity inside the loaded package; must match the registration. */
  readonly manifestProviderId: string;
}

export interface ProviderEvidenceCandidateRun {
  /** Scoped A1 run reference. */
  readonly run: RunEvidenceRunRef;
  /** Actual `agent.spawned` event ID for the attempt being correlated. */
  readonly spawnEventId: string;
  /** Session ID observed from A2 correlation metadata, when known. */
  readonly sessionId?: string;
  readonly dispatch?: ProviderEvidenceDispatchObservation;
}

export interface ProviderUsageEvidenceRequestV1 extends PlainObject {
  readonly kind: typeof PROVIDER_EVIDENCE_REQUEST_KIND;
  readonly schemaVersion: typeof PROVIDER_EVIDENCE_SCHEMA_VERSION;
  readonly observedAt: string;
  readonly provider: ProviderEvidenceProviderRef;
  /**
   * Explicitly authorized private roots. Adapters canonicalize these and
   * reject symlink/realpath escapes; roots are request-only inputs and must
   * never be copied into a response. Relative roots are resolved by the
   * config owner before this request is built.
   */
  readonly providerRoots: readonly string[];
  /**
   * Candidate runs, not one run: a single run cannot prove global session
   * exclusivity, so attribution must state the limits of the observed scope.
   */
  readonly candidates: readonly ProviderEvidenceCandidateRun[];
  readonly limits: ProviderEvidenceLimits;
  /** Cooperative cancellation only; adapters may ignore it without hard isolation. */
  readonly signal?: AbortSignal;
}

export type ProviderEvidenceActivityKind =
  | "assistant"
  | "tool-result"
  | "standalone-usage"
  | "compaction"
  | "branch-summary"
  | "unknown";

/**
 * `run` is uniquely attributed; `shared` is observed for more than one run;
 * `unattributed` has no supported run match; `ambiguous` has conflicting
 * identity evidence. Only `run` may contribute to a run subtotal.
 */
export type ProviderEvidenceAttribution = "run" | "shared" | "unattributed" | "ambiguous";

export interface ProviderUsageCounters {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  /** Already included in output; never add it again. */
  readonly reasoningTokens?: number;
  /** Already included in cacheWrite; never add it again. */
  readonly cacheWrite1hTokens?: number;
}

export interface ProviderUsageCost {
  readonly total: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly currency?: string;
  /** Provider-reported cost only. A3 performs no estimation. */
  readonly basis: "reported";
}

export interface ProviderUsageActivity {
  /** Stable identity (provider + session + persisted entry + facet), never a line/timestamp. */
  readonly activityId: string;
  readonly sessionId: string;
  /** Persisted session-format revision, when known. */
  readonly sessionFormatVersion?: number;
  readonly kind: ProviderEvidenceActivityKind;
  readonly model?: string;
  readonly provider?: string;
  readonly responseId?: string;
  readonly attribution: ProviderEvidenceAttribution;
  /** Present exactly when `attribution` is `run`. */
  readonly run?: RunEvidenceRunRef;
  readonly counters: ProviderUsageCounters;
  readonly cost?: ProviderUsageCost;
}

/**
 * Known scanned subtotal, grouped by attribution scope and model/category.
 * When coverage is partial this is never a lifetime total.
 */
export interface ProviderUsageSubtotal {
  readonly attribution: ProviderEvidenceAttribution;
  readonly run?: RunEvidenceRunRef;
  readonly model?: string;
  readonly kind?: ProviderEvidenceActivityKind;
  readonly counters: ProviderUsageCounters;
  readonly cost?: ProviderUsageCost;
}

export type ProviderEvidenceResponseStatus =
  | "complete"
  | "partial"
  | "unknown"
  | "unsupported"
  | "unavailable";

/**
 * V1 response. `status` encodes all five bridge outcomes:
 * - `complete` / `partial`: validated activities and known scanned subtotals.
 * - `unknown`: the adapter ran but cannot determine usage.
 * - `unsupported`: the source/format/capability is not supported.
 * - `unavailable`: inputs were missing/denied, or reading failed.
 *
 * `coverage` mirrors complete/partial and is `unknown` for the other states.
 * Absence is never zero: empty activities with `complete` means a measured
 * empty scan, while empty activities with any other status means unknown.
 */
export interface ProviderUsageEvidenceV1 extends PlainObject {
  readonly kind: typeof PROVIDER_EVIDENCE_RESPONSE_KIND;
  readonly schemaVersion: typeof PROVIDER_EVIDENCE_SCHEMA_VERSION;
  readonly adapterRevision?: string;
  readonly observedAt: string;
  readonly status: ProviderEvidenceResponseStatus;
  readonly coverage: "complete" | "partial" | "unknown";
  readonly activities: readonly ProviderUsageActivity[];
  readonly subtotals: readonly ProviderUsageSubtotal[];
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
}

/**
 * Executable capability exported beside `trailstepProvider.manifest` and
 * `.hooks`. It is never stored inside the serializable manifest.
 */
export interface ProviderEvidenceAdapterV1 {
  readonly schemaVersion: typeof PROVIDER_EVIDENCE_SCHEMA_VERSION;
  readonly adapterRevision?: string;
  readUsage(request: ProviderUsageEvidenceRequestV1): Promise<ProviderUsageEvidenceV1>;
}

export interface ProviderEvidenceAdapterValidResult {
  readonly status: "valid";
  readonly adapter: ProviderEvidenceAdapterV1;
}

export interface ProviderEvidenceAdapterUnsupportedVersionResult {
  readonly status: "unsupported-version";
  readonly schemaVersion: number;
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
}

export interface ProviderEvidenceAdapterMalformedResult {
  readonly status: "malformed";
  readonly diagnostics: readonly ValidationDiagnostic[];
}

export type ProviderEvidenceAdapterParseResult =
  | ProviderEvidenceAdapterValidResult
  | ProviderEvidenceAdapterUnsupportedVersionResult
  | ProviderEvidenceAdapterMalformedResult;

export interface ProviderUsageEvidenceValidResult {
  readonly status: "valid";
  readonly evidence: ProviderUsageEvidenceV1;
}

export interface ProviderUsageEvidenceUnsupportedVersionResult {
  readonly status: "unsupported-version";
  readonly kind: string;
  readonly schemaVersion: number;
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
}

export interface ProviderUsageEvidenceMalformedResult {
  readonly status: "malformed";
  readonly diagnostics: readonly ValidationDiagnostic[];
}

export type ProviderUsageEvidenceParseResult =
  | ProviderUsageEvidenceValidResult
  | ProviderUsageEvidenceUnsupportedVersionResult
  | ProviderUsageEvidenceMalformedResult;

export interface ProviderEvidenceRegistryEntry {
  readonly registrationId: string;
  readonly manifestProviderId: string;
  readonly adapter: ProviderEvidenceAdapterV1;
  /** Local package root for diagnostics only; never serialized into evidence. */
  readonly packageRoot?: string;
}

export interface ProviderEvidenceRegistry {
  get(registrationId: string): ProviderEvidenceRegistryEntry | undefined;
}

export type ProviderEvidenceInvocationResult =
  | { readonly status: "evidence"; readonly evidence: ProviderUsageEvidenceV1 }
  | { readonly status: "unsupported"; readonly diagnostics: readonly ProviderEvidenceDiagnostic[] }
  | { readonly status: "unavailable"; readonly diagnostics: readonly ProviderEvidenceDiagnostic[] };

export interface ProviderUsageEvidenceRequestValidResult {
  readonly status: "valid";
  readonly request: ProviderUsageEvidenceRequestV1;
}

export interface ProviderUsageEvidenceRequestUnsupportedVersionResult {
  readonly status: "unsupported-version";
  readonly kind: string;
  readonly schemaVersion: number;
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
}

export interface ProviderUsageEvidenceRequestMalformedResult {
  readonly status: "malformed";
  readonly diagnostics: readonly ValidationDiagnostic[];
}

export type ProviderUsageEvidenceRequestParseResult =
  | ProviderUsageEvidenceRequestValidResult
  | ProviderUsageEvidenceRequestUnsupportedVersionResult
  | ProviderUsageEvidenceRequestMalformedResult;
