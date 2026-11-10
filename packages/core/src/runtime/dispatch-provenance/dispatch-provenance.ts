import {
  DISPATCH_PROVENANCE_SCHEMA_VERSION,
  type DispatchProvenance,
  type DispatchProvenanceContext,
  type DispatchProvenanceLayer,
} from "../../contracts/dispatch-provenance/dispatch-provenance.types.js";
import type { Event } from "../../contracts/events/event.types.js";
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

/**
 * Non-mutating side channel carrying the actual `agent.spawned` event ID for
 * a thrown error, keyed by error-object identity.
 *
 * Correlation is deliberately NOT stored in `failure.details`: details are
 * `unknown` diagnostic truth (records, arrays, strings, null, undefined),
 * and diagnostic enrichment must never replace the thrown error, its stack,
 * cause, code, retryability, or details. A `WeakMap` keyed by the exact
 * error instance preserves the original object by reference through every
 * seam, works for frozen errors (it never writes to the error), and drops
 * automatically once the error is garbage-collected. There is no mutable
 * last-dispatch state: each correlation is bound to one error instance, so
 * retries, targets, format attempts, and parallel sibling branches never
 * leak into one another (each attempt throws fresh error instances).
 *
 * Only object/function thrown values can be keyed. Primitive thrown values
 * (`"string"`, numbers, `null`, `undefined`) pass through with no
 * correlation — the same graceful passthrough as before — rather than
 * being wrapped or masked.
 */
const spawnEventIdsByError = new WeakMap<object, string>();

/**
 * Records the actual `agent.spawned` event ID for a thrown error in the
 * side channel and returns the SAME error value unchanged (by reference),
 * so call sites can write `throw correlateSpawnEventId(error, spawnEventId)`
 * without altering identity, stack, cause, code, retryability, or details.
 * First correlation wins: a re-correlation of the same error instance is
 * ignored, keeping the innermost dispatch as the anchor.
 */
export function correlateSpawnEventId(error: unknown, spawnEventId: string): unknown {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const key = error as object;
    if (!spawnEventIdsByError.has(key)) {
      spawnEventIdsByError.set(key, spawnEventId);
    }
  }
  return error;
}

/**
 * Reads the `spawnEventId` previously recorded for the exact thrown error
 * via {@link correlateSpawnEventId}, when present. Reads by error identity
 * (never by `failure.details`), so events can reference the actual spawn
 * attempt while the raw failure remains byte-for-byte unchanged.
 */
export function readSpawnEventId(error: unknown): string | undefined {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    return spawnEventIdsByError.get(error as object);
  }
  return undefined;
}
