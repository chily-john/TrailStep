/**
 * Pre-install script rules: everything under `scripts/` runs before
 * `pnpm install`, so it cannot rely on anything that needs installing or
 * building. The import guard therefore rejects relative import/export
 * specifiers (resolving them would need a module graph or a compile step the
 * pre-install tree does not have); `node:` builtins and bare package specifiers
 * are syntactically allowed here.
 *
 * The allowlist guard keeps `scripts/` to one language plus shell wrappers:
 * TypeScript entry points (run through Node type stripping) and `.sh` boot
 * scripts. Multi-file maintenance code belongs in `factory/`, where dependencies
 * and a build are available.
 */

/** The only extensions a file under `scripts/` may use. */
export const SCRIPT_EXTENSIONS = [".ts", ".sh"] as const;

/**
 * Non-vacuous floor: the five TypeScript entry points plus
 * `refresh-openviking-index.sh`. Adding a legitimate entry point is a deliberate
 * edit to this constant, not a silent pass.
 */
export const SCRIPT_ENTRYPOINT_FLOOR = 6;

/** One file whose extension is outside the `scripts/` allowlist. */
export interface ScriptAllowlistViolation {
  file: string;
  extension: string;
  message: string;
}

/** The file extension including the dot, or `(none)` for an extensionless file. */
function extensionOf(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");

  return dot <= 0 ? "(none)" : name.slice(dot);
}

/**
 * Returns one violation per file outside the `scripts/` allowlist. A `.js`,
 * `.cjs`, `.mjs`, or `.mts` entry point adds a second runtime to the one
 * directory that must run before `pnpm install`.
 * Pure: no filesystem access, so fixture cases stay fast and repo-independent.
 */
export function scriptAllowlistViolations(files: readonly string[]): ScriptAllowlistViolation[] {
  return files.flatMap((file) => {
    if (SCRIPT_EXTENSIONS.some((extension) => file.endsWith(extension))) {
      return [];
    }

    const extension = extensionOf(file);

    return [
      {
        file,
        extension,
        message:
          `${file}: extension is ${JSON.stringify(extension)}. Fix: scripts/ holds one language ` +
          "(TypeScript through Node type stripping) plus shell entry points; put multi-file " +
          "maintenance code in factory/ instead of adding another runtime.",
      },
    ];
  });
}

/**
 * One alternation so a single `matchAll` pass returns every specifier in source
 * order and each statement is counted once: `from "…"` (named imports,
 * `import type`, `export … from`), `import("…")` (dynamic imports), and
 * `import "…"` (side-effect imports). Both quote styles are covered.
 */
const SPECIFIER = new RegExp(
  [
    String.raw`\bfrom\s*(?<fromQuote>['"])(?<fromSpecifier>[^'"]+)\k<fromQuote>`,
    String.raw`\bimport\s*\(\s*(?<dynamicQuote>['"])(?<dynamicSpecifier>[^'"]+)\k<dynamicQuote>`,
    String.raw`\bimport\s*(?<sideEffectQuote>['"])(?<sideEffectSpecifier>[^'"]+)\k<sideEffectQuote>`,
  ].join("|"),
  "gu",
);

/** Every module specifier written in `source`, in source order. */
export function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  for (const match of source.matchAll(SPECIFIER)) {
    const specifier =
      match.groups?.fromSpecifier ??
      match.groups?.dynamicSpecifier ??
      match.groups?.sideEffectSpecifier;

    if (specifier) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

/** The subset of specifiers that resolve relative to the file itself. */
export function relativeSpecifiers(source: string): string[] {
  return importedSpecifiers(source).filter(
    (specifier) => specifier.startsWith(".") || specifier.startsWith("/"),
  );
}

/**
 * Paths a root manifest script invokes directly as `node scripts/<file>`.
 * Used to prove every documented pre-install entry point still exists.
 */
export function preinstallScriptPaths(scripts: Record<string, string>): string[] {
  return Object.values(scripts)
    .filter((command) => command.startsWith("node scripts/"))
    .map((command) => command.split(/\s+/u)[1] ?? "");
}
