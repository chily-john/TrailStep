import path from "node:path";
import ts from "typescript";
import { compareStrings, isInside } from "./path-utils.js";

/** The compiler options and file list parsed from one package tsconfig. */
export interface LoadedTsconfig {
  readonly options: ts.CompilerOptions;
  readonly fileNames: readonly string[];
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

/**
 * Reads a tsconfig with the compiler's own parser, so `extends`, path mapping,
 * and NodeNext semantics match what `tsc` and the build use. A malformed config
 * throws: the graph would otherwise be silently smaller than the package.
 */
export function loadTsconfig(tsconfigPath: string): LoadedTsconfig {
  const absolute = path.resolve(tsconfigPath);
  const read = ts.readConfigFile(absolute, ts.sys.readFile);

  if (read.error) {
    throw new Error(`Cannot read ${absolute}: ${formatDiagnostic(read.error)}`);
  }

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(absolute),
    undefined,
    absolute,
  );

  if (parsed.errors.length > 0) {
    const messages = parsed.errors.map((error) => formatDiagnostic(error)).join("\n");
    throw new Error(`Invalid project ${absolute}:\n${messages}`);
  }

  return {
    options: parsed.options,
    fileNames: parsed.fileNames.map((fileName) => path.resolve(fileName)),
  };
}

const TEST_FILE_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".test.mts",
  ".test.cts",
  ".spec.ts",
  ".spec.tsx",
  ".spec.mts",
  ".spec.cts",
] as const;

/** A colocated or cross-cutting test file, by its conventional suffix. */
export function isTestFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();

  return TEST_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * The analyzed file list: tsconfig inputs under the project root, with tests
 * filtered unless asked for. Sorted with a code-unit comparator so two builds
 * of the same tree produce the same order on every machine.
 */
export function collectSourceFiles(
  loaded: LoadedTsconfig,
  projectRoot: string,
  includeTests: boolean,
): readonly string[] {
  const files = new Set<string>();

  for (const fileName of loaded.fileNames) {
    if (!isInside(projectRoot, fileName)) {
      continue;
    }
    if (!includeTests && isTestFile(fileName)) {
      continue;
    }
    files.add(fileName);
  }

  return [...files].sort(compareStrings);
}
