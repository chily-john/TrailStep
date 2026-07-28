// Isolated token-extraction step of the deprecation scanner: finds every named import bound to
// "@stepkit/core" or "@stepkit/authoring" in a workflow's source text and returns each imported symbol's
// name plus its character offset (used by the scanner to report a line/column).
//
// Known limitations (deliberate, regex/text-based scanning, not a type-checker — see
// deprecation-scanner.ts and packages/cli/README.md):
// - Aliased named imports (`{ step as s }`) are invisible to symbol-name matching; the whole
//   clause is skipped rather than matching either the original or the alias name.
// - Namespace imports (`import * as core from "..."`) produce no `{...}` clause at all, so they
//   are invisible entirely.
export interface ImportSpecifierToken {
  readonly packageName: string;
  readonly symbol: string;
  readonly offset: number;
}

const IMPORT_CLAUSE_PATTERN =
  /import\s*\{([\s\S]*?)\}\s*from\s*["'](@stepkit\/(?:core|authoring))["']/gu;
const ALIASED_IMPORT_CLAUSE = /^(?:type\s+)?[A-Za-z_$][\w$]*\s+as\s+[A-Za-z_$][\w$]*$/u;
const SYMBOL_IMPORT_CLAUSE = /^(?:type\s+)?([A-Za-z_$][\w$]*)$/u;

export function extractStepKitImportTokens(sourceText: string): readonly ImportSpecifierToken[] {
  const tokens: ImportSpecifierToken[] = [];

  for (const importMatch of sourceText.matchAll(IMPORT_CLAUSE_PATTERN)) {
    const packageName = importMatch[2] ?? "";
    const specifierStart = (importMatch.index ?? 0) + (importMatch[0].indexOf("{") + 1);
    let clauseOffset = 0;

    for (const rawClause of (importMatch[1] ?? "").split(",")) {
      const currentClauseOffset = clauseOffset;
      clauseOffset += rawClause.length + 1;

      const clause = rawClause.trim();
      if (clause.length === 0) {
        continue;
      }

      if (ALIASED_IMPORT_CLAUSE.test(clause)) {
        continue;
      }

      const symbolMatch = SYMBOL_IMPORT_CLAUSE.exec(clause);
      if (!symbolMatch) {
        continue;
      }

      const symbol = symbolMatch[1] ?? "";
      // The clause always ends with the bare symbol name (an optional "type " prefix comes before
      // it), so its offset within the untrimmed clause is its leading whitespace plus the trimmed
      // clause's length minus the symbol's own length.
      const leadingWhitespace = rawClause.length - rawClause.trimStart().length;
      const symbolIndexInClause = leadingWhitespace + clause.length - symbol.length;

      tokens.push({
        packageName,
        symbol,
        offset: specifierStart + currentClauseOffset + symbolIndexInClause,
      });
    }
  }

  return tokens;
}
