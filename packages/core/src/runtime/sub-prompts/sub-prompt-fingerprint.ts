import { createHash } from "node:crypto";

import type { PlainObject } from "../../contracts/shapes/shape.types.js";

export function fingerprintSubPrompt(options: {
  readonly input: PlainObject;
  readonly prompt: string;
}): string {
  return createHash("sha256").update(stableJsonStringify(options)).digest("hex");
}

export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
