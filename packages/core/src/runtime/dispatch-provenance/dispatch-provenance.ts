import {
  DISPATCH_PROVENANCE_SCHEMA_VERSION,
  type DispatchProvenance,
  type DispatchProvenanceContext,
  type DispatchProvenanceLayer,
} from "../../contracts/dispatch-provenance/dispatch-provenance.types.js";
import type { Event } from "../../contracts/events/event.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { isPlainObject } from "../../json/guards.js";

/**
 * Dispatch-context provenance helpers (A2b). All helpers are pure and
 * infallible: enrichment must never fail a productive run. Enrichment is
 * passive and idempotent — repeated decoration preserves an existing
 * namespace/references without allocating IDs or nesting wrappers, and
 * explicit context (never mutable global last-dispatch state) is the only
 * source. Unknown fields stay absent.
 */

/**
 * Builds the allowlisted `payload.provenance` namespace from an explicit
 * in-memory dispatch context plus layer counters. Returns `undefined` when
 * neither carries any known field, so call sites can keep the legacy shape
 * (no `provenance` key) via {@link dispatchProvenanceFields}.
 */
export function createDispatchProvenance(
  context: DispatchProvenanceContext | undefined,
  layer: DispatchProvenanceLayer = {},
): DispatchProvenance | undefined {
  const provenance: Record<string, unknown> = {
    schemaVersion: DISPATCH_PROVENANCE_SCHEMA_VERSION,
  };
  if (context?.branchId !== undefined) provenance.branchId = context.branchId;
  if (context?.stepIndex !== undefined) provenance.stepIndex = context.stepIndex;
  if (context?.stepArtifactId !== undefined) provenance.stepArtifactId = context.stepArtifactId;
  if (context?.stepAttempt !== undefined) provenance.stepAttempt = context.stepAttempt;
  if (context?.executionCwd !== undefined) provenance.executionCwd = context.executionCwd;
  if (context?.promptPhaseIndex !== undefined)
    provenance.promptPhaseIndex = context.promptPhaseIndex;
  if (context?.parentStepId !== undefined) provenance.parentStepId = context.parentStepId;
  if (context?.subPromptOrdinal !== undefined)
    provenance.subPromptOrdinal = context.subPromptOrdinal;
  if (layer.targetOrdinal !== undefined) provenance.targetOrdinal = layer.targetOrdinal;
  if (layer.workSpawnTry !== undefined) provenance.workSpawnTry = layer.workSpawnTry;
  if (layer.formatValidationAttempt !== undefined)
    provenance.formatValidationAttempt = layer.formatValidationAttempt;
  if (layer.formatSpawnTry !== undefined) provenance.formatSpawnTry = layer.formatSpawnTry;
  if (layer.spawnEventId !== undefined) provenance.spawnEventId = layer.spawnEventId;

  return Object.keys(provenance).length === 1 ? undefined : (provenance as DispatchProvenance);
}

/**
 * Ergonomic emit-site form of {@link createDispatchProvenance}: spreads to
 * `{ provenance: ... }` when any context is known, or `{}` so the event
 * keeps its legacy shape with no `provenance` key otherwise.
 */
export function dispatchProvenanceFields(
  context: DispatchProvenanceContext | undefined,
  layer: DispatchProvenanceLayer = {},
): { readonly provenance?: DispatchProvenance } {
  const provenance = createDispatchProvenance(context, layer);
  return provenance === undefined ? {} : { provenance };
}

/**
 * Merges a base dispatch context with layer-scoped context fields (for
 * example a subprompt inheriting its parent step's branch/index/attempt and
 * adding its own ordinal). Defined patch fields win; `undefined` patch
 * fields never overwrite base values. Allocates nothing durable and never
 * mutates either input.
 */
export function mergeDispatchProvenanceContext(
  base: DispatchProvenanceContext | undefined,
  patch: DispatchProvenanceContext,
): DispatchProvenanceContext {
  return {
    ...(base?.branchId !== undefined ? { branchId: base.branchId } : {}),
    ...(base?.stepIndex !== undefined ? { stepIndex: base.stepIndex } : {}),
    ...(base?.stepArtifactId !== undefined ? { stepArtifactId: base.stepArtifactId } : {}),
    ...(base?.stepAttempt !== undefined ? { stepAttempt: base.stepAttempt } : {}),
    ...(base?.executionCwd !== undefined ? { executionCwd: base.executionCwd } : {}),
    ...(base?.promptPhaseIndex !== undefined ? { promptPhaseIndex: base.promptPhaseIndex } : {}),
    ...(base?.parentStepId !== undefined ? { parentStepId: base.parentStepId } : {}),
    ...(base?.subPromptOrdinal !== undefined ? { subPromptOrdinal: base.subPromptOrdinal } : {}),
    ...(patch.branchId !== undefined ? { branchId: patch.branchId } : {}),
    ...(patch.stepIndex !== undefined ? { stepIndex: patch.stepIndex } : {}),
    ...(patch.stepArtifactId !== undefined ? { stepArtifactId: patch.stepArtifactId } : {}),
    ...(patch.stepAttempt !== undefined ? { stepAttempt: patch.stepAttempt } : {}),
    ...(patch.executionCwd !== undefined ? { executionCwd: patch.executionCwd } : {}),
    ...(patch.promptPhaseIndex !== undefined ? { promptPhaseIndex: patch.promptPhaseIndex } : {}),
    ...(patch.parentStepId !== undefined ? { parentStepId: patch.parentStepId } : {}),
    ...(patch.subPromptOrdinal !== undefined ? { subPromptOrdinal: patch.subPromptOrdinal } : {}),
  };
}

/**
 * Idempotently decorates an event with a provenance namespace. When
 * `provenance` is `undefined`, or the payload already carries a provenance
 * namespace, the event is returned unchanged — repeated enrichment never
 * nests wrappers, overwrites references, or allocates IDs.
 */
export function withDispatchProvenance(
  event: Event,
  provenance: DispatchProvenance | undefined,
): Event {
  if (provenance === undefined) {
    return event;
  }
  if (isPlainObject(event.payload.provenance)) {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      provenance,
    },
  };
}

/** Failure-detail key carrying the actual `agent.spawned` event ID, when known. */
export const SPAWN_EVENT_ID_DETAIL_KEY = "spawnEventId" as const;

/**
 * Attaches the actual `agent.spawned` event ID to a structured failure's
 * details so outer retry/target seams can reference the failed spawn attempt
 * on their `agent.attemptFailed` events. Idempotent: an existing
 * `spawnEventId` wins. Non-structured errors (cancellation, unexpected
 * errors) and non-record details pass through unchanged — never masked or
 * wrapped.
 */
export function attachSpawnEventId(error: unknown, spawnEventId: string): unknown {
  if (!(error instanceof TrailStepFailureError)) {
    return error;
  }
  const details = error.failure.details;
  if (readSpawnEventId(details) !== undefined) {
    return error;
  }
  return new TrailStepFailureError({
    ...error.failure,
    details: {
      ...(isPlainObject(details) ? details : {}),
      [SPAWN_EVENT_ID_DETAIL_KEY]: spawnEventId,
    },
  });
}

/** Reads the `spawnEventId` attached via {@link attachSpawnEventId}, when present. */
export function readSpawnEventId(details: unknown): string | undefined {
  const value =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>)[SPAWN_EVENT_ID_DETAIL_KEY]
      : undefined;
  return typeof value === "string" ? value : undefined;
}
