import { CliUsageError } from "../command.types.js";

export function readAgentEntryItems(value: unknown): readonly Record<string, unknown>[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new CliUsageError("Agent entry must be an array of objects.");
  }
  return value;
}

export function addAgentEntryItem(
  items: readonly Record<string, unknown>[],
  item: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  return [...items, item];
}

export function removeAgentEntryItem(
  items: readonly Record<string, unknown>[],
  index: number,
): readonly Record<string, unknown>[] {
  assertItemIndex(index, items.length);
  return items.filter((_, itemIndex) => itemIndex !== index);
}

export function reorderAgentEntryItem(
  items: readonly Record<string, unknown>[],
  fromIndex: number,
  toIndex: number,
): readonly Record<string, unknown>[] {
  assertItemIndex(fromIndex, items.length);
  if (toIndex < 0 || toIndex >= items.length) {
    throw new CliUsageError(`Agent item destination index ${toIndex} is out of range.`);
  }

  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item as Record<string, unknown>);
  return next;
}

export function editAgentEntryItem(
  items: readonly Record<string, unknown>[],
  index: number,
  item: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  assertItemIndex(index, items.length);
  return items.map((existing, itemIndex) => (itemIndex === index ? item : existing));
}

function assertItemIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new CliUsageError(`Agent item index ${index} is out of range.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
