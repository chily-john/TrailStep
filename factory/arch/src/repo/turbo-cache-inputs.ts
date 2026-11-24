/**
 * Turbo cache-input rule: `turbo.json` must hash the root `tsconfig.base.json`.
 *
 * Turbo hashes a package task from the package's own files plus the files of
 * its dependencies, so the root base tsconfig is invisible to that hash. Every
 * workspace tsconfig extends it, which means a flag ratchet in the base would
 * replay a stale `typecheck`/`build`/`test:fast` cache instead of failing.
 * Listing it in `globalDependencies` puts it in every task hash.
 *
 * Only the presence of the base config is asserted: extra global dependencies
 * stay allowed. The accepted entry is exactly the plain, repo-root-relative
 * `tsconfig.base.json`, because turbo resolves `globalDependencies` from the
 * turbo root already and rejects an environment-variable prefix there (turbo
 * 2.10.10: "`globalDependencies` cannot contain an environment variable"). The
 * `$TURBO_ROOT$` spelling is only valid in `tasks.*.inputs` globs, so accepting
 * it here would pass a config turbo cannot even load.
 */

export const BASE_TSCONFIG = "tsconfig.base.json";

/** The subset of `turbo.json` this guard reads. */
export interface TurboConfigShape {
  globalDependencies?: unknown;
}

/** One assertion failure: which key is wrong, what it holds, and the message to report. */
export interface TurboCacheInputViolation {
  key: "globalDependencies";
  actual: unknown;
  message: string;
}

const FIX =
  'add "tsconfig.base.json" to globalDependencies; per-package task hashes exclude the root base tsconfig, so a flag change would replay stale cache';

/**
 * Returns a single violation when `globalDependencies` does not contain the
 * base tsconfig. A missing field, an empty array, and an unrelated list are all
 * failures; only the plain spelling counts, since `$TURBO_ROOT$` cannot load.
 * Pure: no filesystem access, so fixture cases stay fast and repo-independent.
 */
export function turboCacheInputViolations(config: TurboConfigShape): TurboCacheInputViolation[] {
  const globalDependencies = config.globalDependencies;
  const entries = Array.isArray(globalDependencies) ? globalDependencies : [];
  const acceptsBaseConfig = entries.includes(BASE_TSCONFIG);

  if (acceptsBaseConfig) {
    return [];
  }

  const found =
    globalDependencies === undefined ? "is missing" : `is ${JSON.stringify(globalDependencies)}`;

  return [
    {
      key: "globalDependencies",
      actual: globalDependencies,
      message: `turbo.json: globalDependencies ${found}. Fix: ${FIX}.`,
    },
  ];
}
