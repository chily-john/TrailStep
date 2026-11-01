import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Marks a CLI test sandbox as its own project root.
 *
 * Commands resolve config, the workflow registry and run artifacts at the project root (the
 * nearest `.git` ancestor), and the test sandboxes live inside this repository's tree. Without a
 * marker they would resolve to the TrailStep repo root instead of the sandbox, so each sandbox
 * gets an (empty) `.git` directory.
 */
export async function markProjectRoot(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".git"), { recursive: true });
}
