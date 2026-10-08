import { TRST_KEY_ORDER } from "./constants.js";

export function serializeOrdered(obj: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  // Explicit key array first: known fields in fixed order
  for (const k of TRST_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      ordered[k] = obj[k];
    }
  }
  // Unknown fields sorted deterministically after known field block
  const unknown = Object.keys(obj)
    .filter((k) => !TRST_KEY_ORDER.includes(k))
    .sort((a, b) => a.localeCompare(b));
  for (const k of unknown) {
    ordered[k] = obj[k];
  }
  return JSON.stringify(ordered);
}
