export type DeprecationTargetPackage = "@stepkit/core" | "@stepkit/authoring";

export interface DeprecationEntry {
  /** Which published package exports this symbol. A symbol re-exported by both (like `step`,
   * which authoring re-exports from core) needs one entry per package it's importable from, since a
   * workflow author might import it from either. */
  readonly package: DeprecationTargetPackage;
  /** The exact named export identifier, e.g. "step". Matched literally against import statement
   * text by the scanner. */
  readonly symbol: string;
  /** Semver version at/after which this symbol is considered deprecated (still works, warns). */
  readonly deprecatedSince: string;
  /** Semver version at/after which this symbol is actually removed (no longer works). Omit if the
   * symbol is deprecated but has no planned removal. */
  readonly removedIn?: string;
  /** Human-readable explanation, shown verbatim in doctor/update output. */
  readonly message: string;
  /** Optional suggested replacement API, shown as "Suggested replacement: <this>." */
  readonly replacement?: string;
}

export type DeprecationManifest = readonly DeprecationEntry[];

export interface DeprecationStatus extends DeprecationEntry {
  readonly severity: "warning" | "blocking";
}
