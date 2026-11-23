/**
 * Pre-install script rule: everything under `scripts/` runs before
 * `pnpm install`, so it cannot rely on anything that needs installing or
 * building. This guard therefore rejects relative import/export specifiers
 * (resolving them would need a module graph or a compile step the pre-install
 * tree does not have). `node:` builtins and bare package specifiers are
 * syntactically allowed here.
 */

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
