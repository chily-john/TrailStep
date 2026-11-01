import type { PlainObject } from "../contracts/shapes/shape.types.js";
import { isPlainObject } from "./guards.js";

const FENCE_PATTERN = /```(?:json|jsonc)?\s*([\s\S]*?)```/giu;

/**
 * Extracts the first balanced JSON object from arbitrary model output.
 *
 * Scanning (rather than slicing from the first `{` to the last `}`) is what
 * makes this resilient to prose that contains braces: `Hope that helps! :}`
 * and `use {x} for templates` around a real JSON object both previously
 * produced an unparseable slice.
 *
 * Strings and escapes are tracked so a `}` inside a string literal does not
 * end the object. Fenced code blocks are tried first because models commonly
 * wrap the answer in one.
 *
 * Returns `undefined` when no balanced object parses. Never throws.
 */
export function extractJsonObject(text: string): PlainObject | undefined {
  const direct = parseObject(text.trim());
  if (direct !== undefined) {
    return direct;
  }

  for (const match of text.matchAll(FENCE_PATTERN)) {
    const fenced = match[1];
    if (fenced === undefined) {
      continue;
    }
    const parsed = parseObject(fenced.trim());
    if (parsed !== undefined) {
      return parsed;
    }
  }

  for (const candidate of balancedObjectCandidates(text)) {
    const parsed = parseObject(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function parseObject(text: string): PlainObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Yields every balanced `{...}` region in document order, longest-first at
 * each start index. Stops at the end of the first object that balances, so
 * `{"a":{"b":1}}` yields the whole thing rather than `{"a":{"b":1}`.
 */
function* balancedObjectCandidates(text: string): Generator<string> {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") {
      continue;
    }
    const end = findBalancedEnd(text, start);
    if (end !== undefined) {
      yield text.slice(start, end + 1);
    }
  }
}

function findBalancedEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}
