/**
 * Public package export-surface rule.
 *
 * Reach-in protection has two halves: a per-package `rootDir: "src"` blocks
 * relative source reach-ins such as `../../core/src/index.js`, and
 * `package.json#exports` blocks deep specifiers such as
 * `@trailstep/core/internal`. A package that exports a subpath re-opens the
 * second half, so the surface stays at `.`: one public entry point per package.
 *
 * The one recorded exemption is `@trailstep/mcp`'s `./package.json`, a
 * pre-existing published shape (W0 D4). Private packages are exempt because
 * they are never published and therefore expose no reach-in surface.
 *
 * This is a shape check, not a resolution check: tsc already proves the export
 * targets resolve.
 */

/** The single public entry point every published package may expose. */
export const SANCTIONED_EXPORT_KEY = ".";

/** A package-and-key pair allowed beyond the `.` surface, with its one-line reason. */
export interface ExportSurfaceExemption {
  packageName: string;
  exportKey: string;
  reason: string;
}

/**
 * The only recorded exemption at green time: `packages/mcp` has shipped
 * `./package.json` since before this guard existed (W0 D4).
 */
export const EXPORT_SURFACE_EXEMPTIONS: readonly ExportSurfaceExemption[] = [
  {
    packageName: "@trailstep/mcp",
    exportKey: "./package.json",
    reason:
      "pre-existing published shape (W0 D4): ./package.json exposes manifest data only, never package source",
  },
];

/** The subset of a `package.json` this guard reads. */
export interface PackageExportsShape {
  name?: string;
  private?: boolean;
  exports?: unknown;
}

/** One assertion failure: which export key is wrong, what it holds, and how to fix it. */
export interface ExportSurfaceViolation {
  key: string;
  actual: unknown;
  fix: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `@trailstep/core/internal` for a named package, used to make the reach-in concrete. */
function reachInExample(shape: PackageExportsShape): string {
  return `${shape.name ?? "this package"}/internal`;
}

/**
 * Returns one violation per key outside the sanctioned `.` surface.
 * Pure: no filesystem access, so fixture cases stay fast and repo-independent.
 */
export function packageExportsViolations(
  shape: PackageExportsShape,
  exemptions: readonly ExportSurfaceExemption[] = EXPORT_SURFACE_EXEMPTIONS,
): ExportSurfaceViolation[] {
  if (shape.private === true) {
    return [];
  }

  const exportsField = shape.exports;
  const reachIn = reachInExample(shape);

  if (exportsField === undefined) {
    return [
      {
        key: "exports",
        actual: exportsField,
        fix: `expose only "."; package.json#exports is what blocks deep reach-ins such as "${reachIn}"`,
      },
    ];
  }

  const exportedKeys =
    typeof exportsField === "string"
      ? [SANCTIONED_EXPORT_KEY]
      : isRecord(exportsField)
        ? Object.keys(exportsField)
        : null;

  if (exportedKeys === null) {
    return [
      {
        key: "exports",
        actual: exportsField,
        fix: `export only "." as an object or string; a malformed exports field cannot block deep reach-ins such as "${reachIn}"`,
      },
    ];
  }

  const violations: ExportSurfaceViolation[] = [];

  if (!exportedKeys.includes(SANCTIONED_EXPORT_KEY)) {
    violations.push({
      key: "exports",
      actual: exportsField,
      fix: `add "."; without it the package has no public entry point and deep reach-ins such as "${reachIn}" stay possible`,
    });
  }

  for (const exportKey of exportedKeys) {
    if (exportKey === SANCTIONED_EXPORT_KEY) {
      continue;
    }

    const exempt = exemptions.some(
      (exemption) => exemption.packageName === shape.name && exemption.exportKey === exportKey,
    );

    if (exempt) {
      continue;
    }

    violations.push({
      key: `exports[${JSON.stringify(exportKey)}]`,
      actual: isRecord(exportsField) ? exportsField[exportKey] : undefined,
      fix: `remove it; package.json#exports exposing only "." blocks deep reach-ins such as "${reachIn}", while rootDir: "src" blocks relative source reach-ins`,
    });
  }

  return violations;
}

/** Renders violations as a failure message naming the manifest, key, and fix. */
export function describePackageExportsViolations(
  relativeManifestPath: string,
  violations: readonly ExportSurfaceViolation[],
): string {
  return violations
    .map(
      (violation) =>
        `${relativeManifestPath}: ${violation.key} is ${JSON.stringify(violation.actual)}. Fix: ${violation.fix}.`,
    )
    .join("\n");
}
