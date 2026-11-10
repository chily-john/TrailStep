import type { PlainObject } from "../shapes/shape.types.js";

/**
 * Bounded dispatch-context provenance contract (A2b).
 *
 * This module is a leaf: it declares types only and imports nothing but the
 * shape contract, so scheduler, continuation, and working-agent code can
 * thread dispatch context without creating an import cycle. It carries only
 * allowlisted execution context — never raw prompts, config values, secrets,
 * or file contents.
 *
 * Provenance is additive and optional. Relevant existing events may carry a
 * `payload.provenance` namespace; the outer event `schemaVersion` stays
 * `"v0"`, event names/IDs and existing payload fields/ordering are
 * untouched, and events without known context stay in their legacy shape
 * (no `provenance` key). Historical events are never mutated or backfilled.
 *
 * Layered retry counters are deliberately distinct fields, not a single
 * shared counter:
 * - `stepAttempt`: the runtime step attempt (`runStepExecution` attempt loop;
 *   absolute, persisted failures + this process's attempts). This is context,
 *   not a globally unique identity — and it is NOT the same field as an
 *   event's existing top-level `payload.attempt`, whose meaning is preserved.
 * - `targetOrdinal`: 1-based position of the selected target in the fallback
 *   chain for one working dispatch.
 * - `workSpawnTry`: 1-based process-level spawn retry for the work phase.
 * - `formatValidationAttempt`: 1-based output-validation attempt of the
 *   same-session format phase (two-phase manifest providers only).
 * - `formatSpawnTry`: 1-based process-level spawn retry for the format phase.
 *
 * `spawnEventId` references the actual `agent.spawned` event ID of the
 * dispatch/spawn attempt an event belongs to, when known. A spawn event
 * represents a dispatch/spawn attempt, not proof of OS process start.
 * Pre-spawn failures carry available context without a fabricated spawn
 * reference. There is no new run UID, dispatch UUID family, or event schema:
 * `agent.spawned` event IDs are the actual-attempt anchors. `sessionId` is
 * not an attempt anchor because formatting reuses sessions.
 */
export const DISPATCH_PROVENANCE_SCHEMA_VERSION = 1 as const;

/**
 * Immutable in-memory dispatch context threaded explicitly from the scheduler
 * branch through continuation, step attempt, dispatch, and working-provider
 * seams. `branchId` is the durable scheduler branch ID when known (never
 * inferred from event proximity); `stepIndex`/`stepArtifactId` are the
 * allocated step index and its artifact identity; `stepAttempt` is the
 * runtime attempt; `executionCwd` is the exact resolved execution cwd
 * (never trimmed/normalized); `promptPhaseIndex` is the prompt phase index
 * within the step. For subprompt-derived dispatches, the step fields
 * describe the PARENT step and `parentStepId`/`subPromptOrdinal` identify
 * the subprompt within it.
 */
export interface DispatchProvenanceContext {
  readonly branchId?: string;
  readonly stepIndex?: number;
  readonly stepArtifactId?: string;
  readonly stepAttempt?: number;
  readonly executionCwd?: string;
  readonly promptPhaseIndex?: number;
  readonly parentStepId?: string;
  readonly subPromptOrdinal?: number;
}

/**
 * The allowlisted optional `payload.provenance` namespace recorded on
 * relevant existing events. `schemaVersion` is this namespace's own version,
 * independent of the outer event schema version.
 */
export interface DispatchProvenance extends PlainObject {
  readonly schemaVersion: typeof DISPATCH_PROVENANCE_SCHEMA_VERSION;
  readonly branchId?: string;
  readonly stepIndex?: number;
  readonly stepArtifactId?: string;
  readonly stepAttempt?: number;
  readonly executionCwd?: string;
  readonly promptPhaseIndex?: number;
  readonly parentStepId?: string;
  readonly subPromptOrdinal?: number;
  readonly targetOrdinal?: number;
  readonly workSpawnTry?: number;
  readonly formatValidationAttempt?: number;
  readonly formatSpawnTry?: number;
  /** Actual `agent.spawned` event ID for this dispatch/spawn attempt, when known. */
  readonly spawnEventId?: string;
}

/** Layer-specific counters attached at each dispatch seam. */
export interface DispatchProvenanceLayer {
  readonly targetOrdinal?: number;
  readonly workSpawnTry?: number;
  readonly formatValidationAttempt?: number;
  readonly formatSpawnTry?: number;
  /** Actual `agent.spawned` event ID for this dispatch/spawn attempt, when known. */
  readonly spawnEventId?: string;
}
