/**
 * Schema-driven coercion of stringified scalar values.
 *
 * An MCP client that stringifies nested workflow input delivers values like
 * `{ maxTurns: "25", summarize: "true" }`, which then fail the workflow's
 * input validation. This module converts a string into the scalar type the
 * JSON schema declares -- but only when the conversion is unambiguous.
 *
 * The coercion is opt-in and never runs inside the shared `jsonSchema()` /
 * `assert()` validators: those also validate agent step outputs, interactive
 * process output and documents, where silently changing a value would be
 * surprising. Callers opt in explicitly at the point where caller-supplied
 * workflow input is validated.
 */

import { isPlainObject } from "../../json/guards.js";

/** Plain decimal only: optional sign, digits, optional fraction. */
const PLAIN_DECIMAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * Coerces stringified scalars in `value` into the types declared by `schema`.
 *
 * - `number` / `integer`: a plain decimal string becomes a number.
 * - `boolean`: exactly `true` / `false` becomes a boolean.
 * - nested `properties` and array `items` are recursed into.
 *
 * Everything else is left untouched: non-strings, empty or whitespace-only
 * strings, strings that are not plain decimals (`"abc"`, `"25abc"`, `"1e5"`,
 * `"0x10"`, `" 25 "`), boolean-ish strings other than `true` / `false`, and
 * values whose schema declares no type (free-form objects).
 *
 * The input value is never mutated; a new value is returned. A no-op input
 * returns an equal (often identical) value.
 */
export function coerceScalarStrings(value: unknown, schema: unknown): unknown {
  return coerceValue(value, asSchemaObject(schema));
}

function coerceValue(value: unknown, schema: Record<string, unknown> | undefined): unknown {
  if (!schema) {
    return value;
  }

  const type = schema.type;

  if (typeof type !== "string") {
    // No declared type: the schema says nothing about the value, so nothing
    // is coerced.
    return value;
  }

  if (type === "number" || type === "integer") {
    return coerceNumber(value, type === "integer");
  }

  if (type === "boolean") {
    return coerceBoolean(value);
  }

  if (type === "object") {
    return coerceObject(value, schema);
  }

  if (type === "array") {
    return coerceArray(value, schema);
  }

  return value;
}

function coerceNumber(value: unknown, integer: boolean): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) {
    // Empty / whitespace-only strings and padded values are not plain decimals.
    return value;
  }

  if (!PLAIN_DECIMAL.test(value)) {
    return value;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  if (integer && !Number.isInteger(parsed)) {
    return value;
  }

  return parsed;
}

function coerceBoolean(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return value;
}

function coerceObject(value: unknown, schema: Record<string, unknown>): unknown {
  if (!isPlainObject(value)) {
    return value;
  }

  const properties = asSchemaObject(schema.properties);
  if (!properties) {
    return value;
  }

  let changed = false;
  const coerced: Record<string, unknown> = { ...value };

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in coerced)) {
      continue;
    }

    const next = coerceValue(coerced[key], asSchemaObject(propertySchema));
    if (next !== coerced[key]) {
      coerced[key] = next;
      changed = true;
    }
  }

  return changed ? coerced : value;
}

function coerceArray(value: unknown, schema: Record<string, unknown>): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  const items = asSchemaObject(schema.items);
  if (!items) {
    return value;
  }

  let changed = false;
  const coerced = value.map((item) => {
    const next = coerceValue(item, items);
    if (next !== item) {
      changed = true;
    }
    return next;
  });

  return changed ? coerced : value;
}

function asSchemaObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
