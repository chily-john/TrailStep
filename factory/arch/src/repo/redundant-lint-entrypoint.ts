/**
 * Lint entry-point rule: `pnpm lint` is one Biome process from the repo root
 * over the same file set the per-package `biome check src` scripts used to
 * cover. A second entry point (a package `lint` script or a turbo `lint` task)
 * silently forks that coverage, so this guard rejects every one and names the
 * offending package or file.
 *
 * The root command is not pinned beyond its target: a future
 * `--error-on-warnings` must not require a test edit, so the guard asserts the
 * first Biome argument after `biome check` is `.` (or `./`) and does not chain
 * `turbo run lint`. A narrower target such as `biome check src` silently leaves
 * the rest of the tree unchecked.
 */

/** The subset of a `package.json` this guard reads. */
export interface PackageManifestShape {
  name?: string;
  scripts?: Record<string, string>;
}

/** A workspace package directory and its parsed manifest. */
export interface WorkspacePackageShape {
  directory: string;
  manifest: PackageManifestShape;
}

/** Everything the guard inspects: workspace manifests, turbo tasks, and the root manifest. */
export interface LintEntrypointShape {
  packages: WorkspacePackageShape[];
  turboTasks?: Record<string, unknown>;
  rootManifest: PackageManifestShape;
}

export type LintEntrypointViolationKey =
  | "package-script"
  | "turbo-task"
  | "root-script"
  | "root-target";

/** One assertion failure: which check broke and the file-plus-fix message to report. */
export interface LintEntrypointViolation {
  key: LintEntrypointViolationKey;
  message: string;
}

const PACKAGE_FIX =
  "remove it; `pnpm lint` runs `biome check .` once from the repo root and already covers every package source";

const ROOT_FIX = "keep a single `biome check .` invocation from the repo root";

const ROOT_TARGET_FIX =
  "run `biome check .` from the repo root; a narrower target silently leaves files outside it unchecked";

/**
 * Returns one violation per broken assertion, in a stable order.
 * Pure: no filesystem access, so fixture cases stay fast and repo-independent.
 */
export function lintEntrypointViolations(shape: LintEntrypointShape): LintEntrypointViolation[] {
  const violations: LintEntrypointViolation[] = [];

  for (const { directory, manifest } of shape.packages) {
    const lint = manifest.scripts?.lint;

    if (lint === undefined) {
      continue;
    }

    violations.push({
      key: "package-script",
      message: `${directory}/package.json: "${manifest.name ?? directory}" declares scripts.lint (${JSON.stringify(lint)}). Fix: ${PACKAGE_FIX}.`,
    });
  }

  if (Object.hasOwn(shape.turboTasks ?? {}, "lint")) {
    violations.push({
      key: "turbo-task",
      message: `turbo.json: declares a "lint" task. Fix: remove the task; ${ROOT_FIX}.`,
    });
  }

  const rootLint = shape.rootManifest.scripts?.lint;
  const rootTokens = rootLint?.trim().split(/\s+/u) ?? [];
  const isBiomeCheck = rootTokens[0] === "biome" && rootTokens[1] === "check";

  if (!isBiomeCheck) {
    violations.push({
      key: "root-script",
      message: `package.json: scripts.lint is ${JSON.stringify(rootLint ?? null)}; it must start with "biome check .". Fix: ${ROOT_FIX}.`,
    });
  } else {
    const target = rootTokens[2];

    if (target !== "." && target !== "./") {
      violations.push({
        key: "root-target",
        message: `package.json: scripts.lint target is ${JSON.stringify(target ?? null)} (script is ${JSON.stringify(rootLint)}). Fix: ${ROOT_TARGET_FIX}.`,
      });
    }
  }

  if (rootLint?.includes("turbo run lint") === true) {
    violations.push({
      key: "root-script",
      message: `package.json: scripts.lint chains \`turbo run lint\` (${JSON.stringify(rootLint)}). Fix: ${ROOT_FIX}.`,
    });
  }

  return violations;
}
