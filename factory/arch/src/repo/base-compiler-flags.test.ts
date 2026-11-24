import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "./root.js";

/**
 * Compiler-flag ratchet over `tsconfig.base.json`.
 *
 * Every workspace tsconfig extends the base, so dropping one flag silently
 * un-tightens packages, `scripts/` and this factory at once. The guard asserts
 * the seven keys and their expected values only: a package may still add any
 * benign compiler option, and the whole `compilerOptions` object is never
 * compared structurally.
 */

const BASE_TSCONFIG_PATH = "tsconfig.base.json";

const FIX_RECIPE =
  "every workspace tsconfig extends this file, so a dropped flag un-tightens all of them at once";

/**
 * Compiler options every workspace inherits; dropping one re-opens a class of bug:
 * enums/namespaces/parameter properties compile again, a mistyped side-effect
 * import compiles silently, and type-only imports lose their explicit marker.
 */
const REQUIRED_BASE_COMPILER_OPTIONS = {
  verbatimModuleSyntax: true,
  noUncheckedSideEffectImports: true,
  moduleDetection: "force",
  noImplicitOverride: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  erasableSyntaxOnly: true,
} as const;

type BaseCompilerOptionValue =
  (typeof REQUIRED_BASE_COMPILER_OPTIONS)[keyof typeof REQUIRED_BASE_COMPILER_OPTIONS];

/**
 * Reads `compilerOptions` from tsconfig text as JSONC: `tsc` accepts comments
 * and trailing commas, so a bare `JSON.parse` would fail a config the compiler
 * is happy with.
 */
function parseBaseCompilerOptions(source: string): Record<string, unknown> {
  const { config, error } = ts.parseConfigFileTextToJson(BASE_TSCONFIG_PATH, source);

  if (error || config === undefined) {
    const detail = error
      ? `TS${error.code}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`
      : "the file is empty";
    throw new Error(`${BASE_TSCONFIG_PATH}: could not be read as a tsconfig (${detail}).`);
  }

  const compilerOptions = (config as { compilerOptions?: unknown }).compilerOptions;

  return typeof compilerOptions === "object" && compilerOptions !== null
    ? (compilerOptions as Record<string, unknown>)
    : {};
}

/** One failure per dropped flag, naming the key, the value found, and the exact fix. */
function baseCompilerFlagViolations(compilerOptions: Record<string, unknown>): string[] {
  return Object.entries(REQUIRED_BASE_COMPILER_OPTIONS).flatMap(([key, expected]) => {
    const actual: unknown = compilerOptions[key];

    if (actual === expected) {
      return [];
    }

    const found = actual === undefined ? "is missing" : `is ${JSON.stringify(actual)}`;
    const wanted = JSON.stringify(expected as BaseCompilerOptionValue);

    return [
      `${BASE_TSCONFIG_PATH}: compilerOptions.${key} ${found}. Fix: set ${wanted}; ${FIX_RECIPE}.`,
    ];
  });
}

const repoRoot = findRepoRoot();

describe("base compiler flags", () => {
  it("keeps the strict base compiler flags", () => {
    const compilerOptions = parseBaseCompilerOptions(
      readFileSync(join(repoRoot, BASE_TSCONFIG_PATH), "utf8"),
    );

    expect(baseCompilerFlagViolations(compilerOptions).join("\n")).toBe("");
  });

  it("names every dropped flag with its expected value", () => {
    const failures = baseCompilerFlagViolations({});

    expect(failures).toHaveLength(7);
    expect(failures.join("\n")).toContain(
      'compilerOptions.moduleDetection is missing. Fix: set "force"',
    );
    expect(failures.join("\n")).toContain(
      "compilerOptions.erasableSyntaxOnly is missing. Fix: set true",
    );
  });

  it("tolerates benign compiler options next to the required ones", () => {
    expect(
      baseCompilerFlagViolations({ ...REQUIRED_BASE_COMPILER_OPTIONS, target: "ES2022" }),
    ).toEqual([]);
  });
});
