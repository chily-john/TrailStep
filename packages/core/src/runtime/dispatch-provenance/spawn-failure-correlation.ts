/**
 * Internal ephemeral spawn-failure correlation (A2b repair).
 *
 * A `SpawnFailureScope` binds at most one terminal failure value (by exact
 * reference) to the `agent.spawned` event ID of the dispatch that produced
 * it. Scopes are explicit, caller-owned side channels passed through
 * existing internal option objects — never a global registry, never
 * `AsyncLocalStorage`, never stored in `failure.details`, and never exported
 * from the package index.
 *
 * Contract:
 * - The creator owns `close()`. Borrowers never close. `close()` is
 *   synchronous, idempotent, non-throwing, clears stored references, and
 *   makes subsequent `record`/`forward` writes ignored.
 * - `record(error, spawnEventId)` is called only at a known dispatch-origin
 *   catch or existing terminal failure-construction site, immediately before
 *   that failure escapes. Successful spawns alone never populate a scope.
 * - `forward(error, child)` copies the child’s association for the exact
 *   escaping value into the parent. It is the only way an association moves
 *   outward. An outer catch never stamps its own spawn over a child origin.
 * - Identical reference + ID re-association is idempotent. Conflicting
 *   associations permanently invalidate the scope (ambiguous), clearing
 *   references. Forwarded ambiguity stays ambiguous. A missing, mismatched,
 *   or closed child never preserves a stale parent binding as fallback —
 *   a previously bound parent is invalidated instead.
 * - Only object/function values are correlatable. Primitive thrown values
 *   pass through unchanged and remain uncorrelated. Frozen values need no
 *   property writes. All checks use `typeof` and reference equality only —
 *   never property inspection, mutation, serialization, or coercion.
 * - `read(error)` returns the spawn-event ID only for a matching bound
 *   reference; absent, mismatched, ambiguous, and closed reads are absent.
 */

type ScopeState = "empty" | "bound" | "ambiguous" | "closed";

function isCorrelatable(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export class SpawnFailureScope {
  private state: ScopeState = "empty";
  private boundError: object | undefined;
  private boundSpawnEventId: string | undefined;

  /**
   * Records `spawnEventId` for `error` if the scope is empty. Identical
   * re-recording is idempotent; a conflicting recording invalidates the
   * scope. Never mutates or replaces `error` and never throws.
   */
  record(error: unknown, spawnEventId: string): void {
    if (this.state === "closed" || this.state === "ambiguous") {
      return;
    }
    if (!isCorrelatable(error)) {
      if (this.state === "bound") {
        this.becomeAmbiguous();
      }
      return;
    }
    if (this.state === "empty") {
      this.state = "bound";
      this.boundError = error;
      this.boundSpawnEventId = spawnEventId;
      return;
    }
    // Bound: idempotent only when both reference and ID match.
    if (this.boundError === error && this.boundSpawnEventId === spawnEventId) {
      return;
    }
    this.becomeAmbiguous();
  }

  /**
   * Forwards the child’s association for the exact escaping `error` into
   * this parent scope. Missing, mismatched, or closed children invalidate a
   * previously bound parent; forwarded ambiguity poisons the parent. Never
   * throws and never mutates `error`.
   */
  forward(error: unknown, child: SpawnFailureScope | undefined): void {
    if (this.state === "closed" || this.state === "ambiguous") {
      return;
    }
    if (!isCorrelatable(error)) {
      if (this.state === "bound") {
        this.becomeAmbiguous();
      }
      return;
    }
    if (
      !(child instanceof SpawnFailureScope) ||
      child.state === "empty" ||
      child.state === "closed"
    ) {
      if (this.state === "bound") {
        this.becomeAmbiguous();
      }
      return;
    }
    if (child.state === "ambiguous") {
      this.becomeAmbiguous();
      return;
    }
    // Child is bound.
    if (child.boundError !== error) {
      if (this.state === "bound") {
        this.becomeAmbiguous();
      }
      return;
    }
    const childSpawnEventId = child.boundSpawnEventId;
    if (this.state === "empty") {
      this.state = "bound";
      this.boundError = error;
      this.boundSpawnEventId = childSpawnEventId;
      return;
    }
    if (this.boundError === error && this.boundSpawnEventId === childSpawnEventId) {
      return;
    }
    this.becomeAmbiguous();
  }

  /**
   * Reads the spawn-event ID bound to the exact `error` reference without
   * searching any other scope. Returns `undefined` when absent.
   */
  read(error: unknown): string | undefined {
    if (this.state !== "bound") {
      return undefined;
    }
    if (!isCorrelatable(error)) {
      return undefined;
    }
    return this.boundError === error ? this.boundSpawnEventId : undefined;
  }

  /**
   * Clears all references and prevents future writes. Idempotent and
   * non-throwing.
   */
  close(): void {
    this.state = "closed";
    this.boundError = undefined;
    this.boundSpawnEventId = undefined;
  }

  private becomeAmbiguous(): void {
    this.state = "ambiguous";
    this.boundError = undefined;
    this.boundSpawnEventId = undefined;
  }
}

export function createSpawnFailureScope(): SpawnFailureScope {
  return new SpawnFailureScope();
}
