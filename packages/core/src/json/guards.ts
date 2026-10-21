import type { PlainObject } from "../contracts/shapes/shape.types.js";

/**
 * Canonical guards for loosely typed values.
 *
 * These helpers are the single source of truth inside `@trailstep/core` for
 * "is this value shaped like X?" questions. Modules must import them from
 * here instead of redefining local copies.
 */

/**
 * True when `value` is a record-like object: an object that is neither `null`
 * nor an array.
 *
 * This is the permissive form: it also accepts class instances, `Date`s and
 * objects with a `null` prototype. Use it for values that are known to be
 * plain JSON-ish data but whose origin is unknown.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `value` is a plain object: an object whose prototype is either
 * `Object.prototype` or `null`.
 *
 * Arrays, `Date`s and class instances are rejected. This is the strict form
 * and is the canonical definition of "plain object" in this package.
 */
export function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * True when `error` is an `Error` carrying a Node.js `code` property.
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Renders an unknown thrown value as a human-readable message.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
