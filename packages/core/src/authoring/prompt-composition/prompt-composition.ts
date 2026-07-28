import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Synchronously reads each named file relative to `dir` and returns its
 * trimmed content keyed the same way, so a step's `prompt.ts` can load all
 * of its shared markdown fragments in one call:
 * `loadFragments(import.meta.dirname, { methodology: "../shared/methodology.md" })`.
 */
export function loadFragments<TKey extends string>(
  dir: string,
  files: Record<TKey, string>,
): Record<TKey, string> {
  const fragments = {} as Record<TKey, string>;

  for (const key of Object.keys(files) as TKey[]) {
    fragments[key] = readFileSync(join(dir, files[key]), "utf8").trimEnd();
  }

  return fragments;
}

/**
 * Renders `body` as a `## title` markdown section, or `undefined` when
 * `body` is falsy -- so a conditional section can be inlined directly as a
 * `promptSections(...)` argument instead of built up separately.
 */
export function section(
  title: string,
  body: string | false | null | undefined,
): string | undefined {
  return body ? `## ${title}\n\n${body.trimEnd()}` : undefined;
}

/**
 * Joins prompt fragments and `section(...)` results with a blank line
 * between each, dropping any falsy (conditionally-omitted) part.
 */
export function promptSections(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Renders `items` as a markdown bullet list, one `- item` per line. */
export function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}
