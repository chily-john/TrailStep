import type { PlainObject, ValidationDiagnostic } from "../shapes/shape.types.js";

/**
 * Bounded provider-neutral run evidence contract (A1 V1).
 *
 * This module is a leaf: it declares types and constants only and imports
 * nothing but the shape contract, so runtime/projector code can depend on it
 * without creating a cycle. No acceptance/rubric/proposal/confidence fields
 * live here — those belong to a future factory package.
 *
 * The envelope intentionally carries no raw transition payloads, no extra
 * run UID, and no normalized usage counters. Usage is represented only via
 * {@link EvidenceAvailability} so that Pi counter normalization can wait for
 * concrete producer fixtures (A3).
 */

export const RUN_EVIDENCE_KIND = "trailstep.run-evidence" as const;
export const RUN_EVIDENCE_SCHEMA_VERSION = 1 as const;
/**
 * Current projector revision. A projector change does not by itself imply a
 * schema change: bumping this revision must remain backward compatible with
 * schema version 1 readers, while changing field meanings or required fields
 * requires a new schema version.
 */
export const RUN_EVIDENCE_PROJECTOR_REVISION = "1" as const;

/**
 * Scoped project identity. A project must be identified by an explicit key
 * or by a canonical-root identity marked local. It is never inferred from a
 * Git remote URL, global configuration, or an execution basename/worktree,
 * which would silently merge distinct clones.
 */
export type EvidenceProjectIdentity =
  | { readonly kind: "explicit"; readonly key: string }
  | { readonly kind: "local"; readonly rootRef: string };

/**
 * How strongly the run reference identifies a distinct run incarnation.
 * - `explicit`: explicit project key with original start identity available.
 * - `local`: canonical-root local identity (relocation/clone equivalence
 *   requires an explicit mapping, which is out of scope for A1).
 * - `legacy-ambiguous`: historical runs without provenance that must not be
 *   silently merged or deduplicated.
 * - `unknown`: insufficient provenance to claim uniqueness.
 */
export type EvidenceIdentityQuality = "explicit" | "local" | "legacy-ambiguous" | "unknown";

export interface RunEvidenceRunRef {
  readonly project: EvidenceProjectIdentity;
  /** Actual run ID as stored locally. A directory name is a locator, not identity. */
  readonly runId: string;
  /**
   * Original `workflow.started` event ID. The durable start event is the
   * run-incarnation identifier: it stays stable across resume/retry/continue
   * because initialization preserves it. Absent for legacy runs.
   */
  readonly startedEventId?: string;
  readonly workflowId?: string;
  readonly identityQuality: EvidenceIdentityQuality;
}

/**
 * Projected execution state only. It is orthogonal to storage location and
 * read coverage and never implies an accepted/validated outcome.
 */
export type EvidenceExecutionState =
  | "active"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "unknown";

/** Where the source run lives right now, kept separate from execution state. */
export type EvidenceStorageLocation = "hot" | "archived" | "missing" | "unreadable";

/** Whether coverage of the available sources is complete, partial, or unknown. */
export type EvidenceCoverage = "complete" | "partial" | "unknown";

/** Bounded diagnostic codes. Free-form messages must never echo secrets. */
export type EvidenceDiagnosticCode =
  | "unsupported-version"
  | "malformed-record"
  | "missing-source"
  | "unreadable-source"
  | "changed-source"
  | "partial-coverage"
  | "ambiguous-identity"
  | "budget-exceeded"
  | "stale-owner"
  | "permission-denied"
  | "unsupported-source";

export interface EvidenceDiagnostic {
  readonly code: EvidenceDiagnosticCode;
  /** Bounded, redacted human message. Must not echo secrets or parser input. */
  readonly message?: string;
}

export interface EvidenceExecutionObservation {
  readonly state: EvidenceExecutionState;
  readonly storage: EvidenceStorageLocation;
  readonly coverage: EvidenceCoverage;
  readonly diagnostics: readonly EvidenceDiagnostic[];
}

/**
 * Safe logical reference to an artifact or event within a run. Exactly one
 * of `artifactPath`/`eventId` is required: this union makes both selectors
 * and neither selector unrepresentable for hand-authored code, while the
 * runtime schema (`sourceRefSchema`) rejects ambiguous input as `malformed`
 * instead of silently dropping a selector. `digest` is an optional
 * selected-range digest for detecting changed evidence; whole growing-trail
 * fingerprints must not be used to redefine identity.
 */
export type EvidenceSourceRef =
  | {
      readonly run: RunEvidenceRunRef;
      readonly artifactPath: string;
      readonly eventId?: undefined;
      readonly digest?: string;
    }
  | {
      readonly run: RunEvidenceRunRef;
      readonly eventId: string;
      readonly artifactPath?: undefined;
      readonly digest?: string;
    };

/** Generic link to a separately owned artifact, without assessment content. */
export interface EvidenceLinkedArtifactRef {
  readonly label?: string;
  readonly source: EvidenceSourceRef;
}

export type EvidenceAvailabilityReason =
  | "disabled"
  | "missing"
  | "unsupported"
  | "malformed"
  | "ambiguous"
  | "permission-denied"
  | "budget-exceeded";

/**
 * Availability of a measurement. A measured zero is a `known` value of 0
 * and must never be conflated with `unknown`; absence is never zero, and
 * empty arrays alone do not prove complete absence.
 */
export type EvidenceAvailability<T> =
  | { readonly state: "known"; readonly value: T }
  | {
      readonly state: "partial";
      readonly value: T;
      readonly reasons: readonly EvidenceAvailabilityReason[];
    }
  | { readonly state: "unknown"; readonly reasons: readonly EvidenceAvailabilityReason[] };

export interface RunEvidence extends PlainObject {
  readonly kind: typeof RUN_EVIDENCE_KIND;
  readonly schemaVersion: typeof RUN_EVIDENCE_SCHEMA_VERSION;
  readonly observedAt: string;
  readonly projectorRevision: string;
  readonly run: RunEvidenceRunRef;
  readonly execution: EvidenceExecutionObservation;
  /** Optional V1 usage availability (e.g. a measured count). No normalized counters yet. */
  readonly usage?: EvidenceAvailability<number>;
  readonly linkedArtifacts?: readonly EvidenceLinkedArtifactRef[];
}

export interface RunEvidenceValidResult {
  readonly status: "valid";
  readonly evidence: RunEvidence;
}

export interface RunEvidenceUnsupportedVersionResult {
  readonly status: "unsupported-version";
  readonly kind: string;
  readonly schemaVersion: number;
  readonly diagnostics: readonly EvidenceDiagnostic[];
}

export interface RunEvidenceMalformedResult {
  readonly status: "malformed";
  readonly diagnostics: readonly ValidationDiagnostic[];
}

export type RunEvidenceParseResult =
  | RunEvidenceValidResult
  | RunEvidenceUnsupportedVersionResult
  | RunEvidenceMalformedResult;
