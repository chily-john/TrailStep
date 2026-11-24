/**
 * Canonical package `tsconfig.json` shape.
 *
 * Reach-in safety comes from exactly two mechanisms: `package.json#exports`
 * exposing only `.` (blocks deep specifiers) and a per-package `rootDir: "src"`
 * (blocks relative reach-ins such as `../../core/src/index.js`). Anything that
 * widens `rootDir`, aliases another package's `src` through `paths`/`baseUrl`,
 * or introduces project `references`/`composite` silently disables the second
 * mechanism, so those keys are invalid regardless of what else the package does.
 *
 * Only the asserted keys are compared structurally: a package may add a benign
 * compiler option without touching this guard.
 */

export const CANONICAL_EXTENDS = "../../tsconfig.base.json";
export const CANONICAL_INCLUDE_ENTRY = "src/**/*.ts";
export const CANONICAL_ROOT_DIR = "src";
export const CANONICAL_OUT_DIR = "dist";

/** Keys that mute relative reach-in detection. */
export const FORBIDDEN_COMPILER_OPTIONS = ["paths", "baseUrl", "references", "composite"];

/**
 * Keys that must never appear in a config every workspace package inherits
 * (`tsconfig.base.json`) or in the root project config (`tsconfig.json`).
 * `rootDir` and `allowImportingTsExtensions` are harmless in a single package
 * but fatal when they apply to every package at once.
 */
export const SHARED_FORBIDDEN_COMPILER_OPTIONS = [
  "paths",
  "baseUrl",
  "references",
  "composite",
  "rootDir",
  "allowImportingTsExtensions",
] as const;

/** The subset of `tsconfig.json` this guard reads. */
export interface PackageTsconfigShape {
  extends?: unknown;
  include?: unknown;
  compilerOptions?: Record<string, unknown>;
  references?: unknown;
}

/** One assertion failure: which key is wrong, what it holds, and how to fix it. */
export interface TsconfigViolation {
  key: string;
  actual: unknown;
  fix: string;
}

const REACH_IN_FIX =
  'reach-in protection comes from package.json#exports plus rootDir: "src", so import the published package instead of widening this config';

const SHARED_REACH_IN_FIX =
  "reach-in protection comes from per-package package.json#exports plus each package's own rootDir, and a base-level key would apply to every package at once";

/**
 * Returns one violation per broken assertion, in a stable order.
 * Pure: no filesystem access, so fixture cases stay fast and repo-independent.
 */
export function packageTsconfigViolations(config: PackageTsconfigShape): TsconfigViolation[] {
  const violations: TsconfigViolation[] = [];
  const compilerOptions = config.compilerOptions ?? {};
  const include = Array.isArray(config.include) ? config.include : [];

  if (config.extends !== CANONICAL_EXTENDS) {
    violations.push({
      key: "extends",
      actual: config.extends,
      fix: `set "extends": "${CANONICAL_EXTENDS}"`,
    });
  }

  if (compilerOptions.rootDir !== CANONICAL_ROOT_DIR) {
    violations.push({
      key: "compilerOptions.rootDir",
      actual: compilerOptions.rootDir,
      fix: `set "rootDir": "${CANONICAL_ROOT_DIR}"; a widened rootDir lets this package compile another package's sources. ${REACH_IN_FIX}`,
    });
  }

  if (compilerOptions.outDir !== CANONICAL_OUT_DIR) {
    violations.push({
      key: "compilerOptions.outDir",
      actual: compilerOptions.outDir,
      fix: `set "outDir": "${CANONICAL_OUT_DIR}"`,
    });
  }

  if (!include.includes(CANONICAL_INCLUDE_ENTRY)) {
    violations.push({
      key: "include",
      actual: config.include,
      fix: `include "${CANONICAL_INCLUDE_ENTRY}"`,
    });
  }

  for (const key of FORBIDDEN_COMPILER_OPTIONS) {
    if (Object.hasOwn(compilerOptions, key)) {
      violations.push({
        key: `compilerOptions.${key}`,
        actual: compilerOptions[key],
        fix: `remove "compilerOptions.${key}"; ${REACH_IN_FIX}`,
      });
    }
  }

  if (config.references !== undefined) {
    violations.push({
      key: "references",
      actual: config.references,
      fix: `remove "references": project references suppress the TS6059 relative reach-in error; ${REACH_IN_FIX}`,
    });
  }

  return violations;
}

/**
 * Returns one violation per forbidden key in a shared or root config.
 * `packageTsconfigViolations` is deliberately untouched: a package still owns
 * its `rootDir`, so only these two files must stay free of these keys.
 * Pure: no filesystem access, so fixture cases stay fast and repo-independent.
 */
export function sharedTsconfigViolations(config: PackageTsconfigShape): TsconfigViolation[] {
  const violations: TsconfigViolation[] = [];
  const compilerOptions = config.compilerOptions ?? {};

  for (const key of SHARED_FORBIDDEN_COMPILER_OPTIONS) {
    if (Object.hasOwn(compilerOptions, key)) {
      violations.push({
        key: `compilerOptions.${key}`,
        actual: compilerOptions[key],
        fix: `remove "compilerOptions.${key}"; ${SHARED_REACH_IN_FIX}`,
      });
    }
  }

  if (config.references !== undefined) {
    violations.push({
      key: "references",
      actual: config.references,
      fix: `remove "references": project references suppress the TS6059 relative reach-in error; ${SHARED_REACH_IN_FIX}`,
    });
  }

  return violations;
}

/** Renders violations as a failure message that names the file, the key, and the fix. */
export function describePackageTsconfigViolations(
  relativeConfigPath: string,
  violations: TsconfigViolation[],
): string {
  return violations
    .map(
      (violation) =>
        `${relativeConfigPath}: ${violation.key} is ${JSON.stringify(violation.actual)}. Fix: ${violation.fix}.`,
    )
    .join("\n");
}
