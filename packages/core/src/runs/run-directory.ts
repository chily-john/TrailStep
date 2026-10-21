/**
 * Shared run-artifact directory helpers.
 *
 * These are the single implementation of "where does a run live" for every
 * TrailStep surface (CLI, MCP). They used to be duplicated in
 * `packages/cli/src/internals/runs-root.ts`,
 * `packages/cli/src/internals/commands/wait-run-helpers.ts` and
 * `packages/mcp/src/tools/run-wait-files.ts`; the MCP package cannot import
 * from the CLI package (the CLI already depends on the MCP package), so the
 * shared primitives live here in core.
 *
 * CLI-specific concerns (archived-run awareness and the `storage restore`
 * hint) stay in the CLI wrapper and hook into the resolution through
 * `ResolveRunDirectoryOptions.onRunNotFound`.
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { type Event, readRunEvents, TRAILSTEP_DIR_NAME } from "../runtime/artifacts/run-storage.js";

/** Environment variable that overrides the runs root. */
export const TRAILSTEP_RUNS_ROOT_ENV = "TRAILSTEP_RUNS_ROOT";

export interface RunDirectoryContext {
  /** Directory the runs root is resolved against. */
  readonly cwd: string;
  /** Environment used for the `TRAILSTEP_RUNS_ROOT` override. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedRunDirectory {
  /** Absolute path of the run directory. */
  readonly runDir: string;
  /** The name (or path) the caller asked for. */
  readonly displayName: string;
}

export interface RunNotFoundContext {
  /** The run name (or path) the caller asked for. */
  readonly runNameOrRunDir: string;
  /** Resolved runs root the named candidate was looked up in. */
  readonly runsRoot: string;
  /** Candidate directory the run would live in. */
  readonly runDir: string;
}

export interface ResolveRunDirectoryOptions {
  /**
   * Called when no run directory with an events file was found, before the
   * resolution falls back to the direct path candidate. Implementations may
   * throw to abort the resolution (the CLI does that for archived runs).
   */
  readonly onRunNotFound?: (context: RunNotFoundContext) => void | Promise<void>;
}

/** The configured runs root (resolved against the cwd), or undefined. */
export function resolveConfiguredRunsRoot(context: RunDirectoryContext): string | undefined {
  const configured = context.env?.[TRAILSTEP_RUNS_ROOT_ENV]?.trim();
  if (!configured) {
    return undefined;
  }

  return resolve(context.cwd, configured);
}

/** The runs root: the `TRAILSTEP_RUNS_ROOT` override or `<cwd>/.trailstep/runs`. */
export function resolveRunsRoot(context: RunDirectoryContext): string {
  return resolveConfiguredRunsRoot(context) ?? join(context.cwd, TRAILSTEP_DIR_NAME, "runs");
}

/**
 * Whether a value looks like a filesystem path rather than a bare run name.
 */
export function isPathLike(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  );
}

/** Whether a run directory carries an `events.jsonl` artifact. */
export async function hasEventsFile(runDir: string): Promise<boolean> {
  try {
    await access(join(runDir, "events.jsonl"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a run name (under the runs root) or a run directory path.
 *
 * Direct path candidates win when they carry an events file, then the named
 * candidate under the runs root. Archived-run awareness is a CLI concern and
 * is injected through `options.onRunNotFound`.
 */
export async function resolveRunDirectory(
  runNameOrRunDir: string,
  context: RunDirectoryContext,
  options: ResolveRunDirectoryOptions = {},
): Promise<ResolvedRunDirectory> {
  const runsRoot = resolveRunsRoot(context);
  const directCandidate = isPathLike(runNameOrRunDir)
    ? resolve(context.cwd, runNameOrRunDir)
    : undefined;
  if (directCandidate !== undefined && (await hasEventsFile(directCandidate))) {
    return { runDir: directCandidate, displayName: runNameOrRunDir };
  }

  const namedCandidate = join(runsRoot, runNameOrRunDir);
  if (await hasEventsFile(namedCandidate)) {
    return { runDir: namedCandidate, displayName: runNameOrRunDir };
  }

  if (options.onRunNotFound !== undefined) {
    await options.onRunNotFound({
      runNameOrRunDir,
      runsRoot,
      runDir: directCandidate ?? namedCandidate,
    });
  }

  if (directCandidate !== undefined) {
    return { runDir: directCandidate, displayName: runNameOrRunDir };
  }

  return { runDir: namedCandidate, displayName: runNameOrRunDir };
}

/** Read the event stream of a run directory. */
export async function readEventsForRun(runDir: string): Promise<readonly Event[]> {
  return await readRunEvents(runDir);
}
