/**
 * Single @trailstep/cli entry resolution for the MCP tools.
 *
 * The MCP package previously had two divergent `resolveCliEntry`
 * implementations: `run_workflow.ts` detected the CLI through `process.argv`
 * and `trst_resume.ts` walked up `node_modules`. They now share ONE module
 * with ONE `TRAILSTEP_CLI_ENTRY` handling and ONE resolution strategy:
 *
 * 1. an explicit CLI entry option,
 * 2. the `TRAILSTEP_CLI_ENTRY` environment override (used verbatim),
 * 3. the running process, when this process IS the trailstep CLI
 *    (`trailstep mcp` foreground server),
 * 4. a node_modules / workspace walk-up for the installed or workspace CLI.
 *
 * Callers that must not fall back to an implicit lookup (the `run_workflow`
 * tool, whose win32 PATH-fallback refusal depends on knowing whether the
 * entry was explicitly configured) pass `allowWorkspaceLookup: false`.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Environment variable that points at the built @trailstep/cli entry. */
export const TRAILSTEP_CLI_ENTRY_ENV = "TRAILSTEP_CLI_ENTRY";

export interface ResolveCliEntryOptions {
  /** Explicit CLI entry path (highest precedence). */
  readonly cliEntry?: string;
  /**
   * Allow the node_modules / workspace walk-up lookup. Defaults to true;
   * `run_workflow` disables it so its PATH-fallback contract stays intact.
   */
  readonly allowWorkspaceLookup?: boolean;
}

/**
 * Resolve the @trailstep/cli entry, or undefined when none can be resolved.
 *
 * @param env Environment used for the `TRAILSTEP_CLI_ENTRY` override.
 * @param options Explicit entry and lookup policy.
 */
export function resolveCliEntry(
  env?: Readonly<Record<string, string | undefined>>,
  options: ResolveCliEntryOptions = {},
): string | undefined {
  const explicit = options.cliEntry?.trim();
  if (explicit) {
    return resolve(explicit);
  }

  const fromEnv = env?.[TRAILSTEP_CLI_ENTRY_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const fromProcess = detectCliEntryFromProcess();
  if (fromProcess) {
    return fromProcess;
  }

  if (options.allowWorkspaceLookup === false) {
    return undefined;
  }

  return findCliEntryInWorkspace();
}

/** Detect the CLI entry when the running process IS the trailstep CLI. */
function detectCliEntryFromProcess(): string | undefined {
  const entry = process.argv[1];
  if (!entry) {
    return undefined;
  }
  const resolvedEntry = resolve(entry);
  if (basename(resolvedEntry) !== "index.js" || !existsSync(resolvedEntry)) {
    return undefined;
  }
  try {
    const packageJsonPath = join(dirname(resolvedEntry), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return packageJson.name === "@trailstep/cli" ? resolvedEntry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Walk up from this module looking for the installed (node_modules) or
 * workspace (@trailstep/cli) CLI build. Covers the pnpm workspace layout
 * (packages/cli/dist) and node_modules installs.
 */
function findCliEntryInWorkspace(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const nodeModulesCandidate = join(
      current,
      "node_modules",
      "@trailstep",
      "cli",
      "dist",
      "index.js",
    );
    if (existsSync(nodeModulesCandidate)) {
      return nodeModulesCandidate;
    }

    const workspaceCandidate = join(current, "packages", "cli", "dist", "index.js");
    if (existsSync(workspaceCandidate)) {
      return workspaceCandidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
