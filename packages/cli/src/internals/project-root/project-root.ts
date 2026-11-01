import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { TRAILSTEP_DIR_NAME } from "@trailstep/core";

export const TRAILSTEP_PROJECT_ROOT_ENV = "TRAILSTEP_PROJECT_ROOT";

export interface ResolveProjectRootOptions {
  /** Starting directory. Defaults to `process.cwd()`. */
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam for filesystem probes. */
  readonly exists?: (path: string) => Promise<boolean>;
}

/**
 * Finds the project root for TrailStep config, runs and artifacts.
 *
 * Every comparable tool (git, pnpm, eslint, tsconfig) walks up to a root marker instead of
 * anchoring on the invocation directory. Anchoring on `cwd` meant that running a workflow from
 * a nested package created a second `.trailstep/` tree there, silently ignoring the project's
 * real config and runs root.
 *
 * Order:
 * 1. `TRAILSTEP_PROJECT_ROOT` when set (absolute, or resolved against `cwd`).
 * 2. `cwd` itself when it already holds a `.trailstep` directory: an existing TrailStep
 *    directory is already a root, so invoking from inside one must not silently redirect config
 *    and runs to an ancestor project. `TRAILSTEP_PROJECT_ROOT` overrides it.
 * 3. The nearest ancestor containing `.git`.
 * 4. The nearest ancestor containing a `package.json` that is not inside `node_modules`.
 * 5. `cwd` itself.
 */
export async function resolveProjectRoot(options: ResolveProjectRootOptions): Promise<string> {
  const start = resolve(options.cwd);
  const exists = options.exists ?? defaultExists;

  const override = options.env?.[TRAILSTEP_PROJECT_ROOT_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    return resolve(start, override.trim());
  }

  if (await exists(join(start, TRAILSTEP_DIR_NAME))) {
    return start;
  }

  const gitRoot = await findAncestor(start, (dir) => exists(join(dir, ".git")));
  if (gitRoot !== undefined) {
    return gitRoot;
  }

  const packageRoot = await findAncestor(start, async (dir) => {
    if (dir.split(/[\\/]/u).includes("node_modules")) {
      return false;
    }
    const hasPackageJson = await exists(join(dir, "package.json"));
    return hasPackageJson;
  });
  if (packageRoot !== undefined) {
    return packageRoot;
  }

  return start;
}

async function findAncestor(
  start: string,
  predicate: (dir: string) => Promise<boolean>,
): Promise<string | undefined> {
  let current = start;
  for (;;) {
    if (await predicate(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
