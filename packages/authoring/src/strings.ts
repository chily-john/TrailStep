/**
 * Shared string normalization helpers for workflow authoring packages.
 *
 * These helpers define the canonical "trim, then drop empty" semantics used
 * when normalizing optional workflow inputs, so that every package treats
 * blank strings the same way.
 */

/**
 * Returns the trimmed value when it is non-empty, otherwise `undefined`.
 */
export function nonEmptyOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns the trimmed value when it is non-empty, otherwise `fallback`.
 */
export function nonEmptyOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}
