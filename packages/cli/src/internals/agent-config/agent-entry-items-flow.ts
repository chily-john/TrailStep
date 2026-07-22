import { CliUsageError } from "../command.types.js";

export function replaceAgentEntryItems(
  entry: Record<string, unknown>,
  items: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { ...entry, items: [...items] };
}

export function addAgentEntryItem(
  entry: Record<string, unknown>,
  item: Record<string, unknown>,
): Record<string, unknown> {
  return replaceAgentEntryItems(entry, [...readItems(entry), item]);
}

export function removeAgentEntryItem(
  entry: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const items = readItems(entry);
  assertItemIndex(index, items.length);
  return { ...entry, items: items.filter((_, itemIndex) => itemIndex !== index) };
}

export function reorderAgentEntryItem(
  entry: Record<string, unknown>,
  fromIndex: number,
  toIndex: number,
): Record<string, unknown> {
  const items = [...readItems(entry)];
  assertItemIndex(fromIndex, items.length);
  if (toIndex < 0 || toIndex >= items.length) {
    throw new CliUsageError(`Agent item destination index ${toIndex} is out of range.`);
  }

  const [item] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, item as Record<string, unknown>);
  return { ...entry, items };
}

export function editAgentEntryItem(
  entry: Record<string, unknown>,
  index: number,
  item: Record<string, unknown>,
): Record<string, unknown> {
  const items = readItems(entry);
  assertItemIndex(index, items.length);
  return {
    ...entry,
    items: items.map((existing, itemIndex) => (itemIndex === index ? item : existing)),
  };
}

function readItems(entry: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (entry.items === undefined) {
    return [];
  }
  if (!Array.isArray(entry.items) || !entry.items.every(isRecord)) {
    throw new CliUsageError("Agent entry items must be an array of objects.");
  }
  return entry.items;
}

function assertItemIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new CliUsageError(`Agent item index ${index} is out of range.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
