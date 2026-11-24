import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the repository root by walking up from this module to the directory
 * holding `pnpm-workspace.yaml`. Counting `..` segments breaks as soon as this
 * file moves, so the marker file is the single source of truth.
 */
export function findRepoRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  let current = start;

  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find the repository root: no pnpm-workspace.yaml above ${start}.`);
    }
    current = parent;
  }
}
