import ts from "typescript";
import type { EdgeKind } from "./types.js";

/** One module specifier found in a source file, with its classification. */
export interface CollectedSpecifier {
  readonly specifier: string;
  readonly kind: EdgeKind;
  /** 1-based, matching editor and SARIF positions. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
}

/**
 * `import type`, and an import whose named bindings are all `type`, are
 * type-only. A default or namespace binding is a value binding even when the
 * author only uses it in type positions. A mixed list (`{ type A, b }`) is a
 * value edge: amended G-2a counts it, and the runtime import is present.
 */
function classifyImport(clause: ts.ImportClause | undefined): EdgeKind {
  if (!clause) {
    return "value";
  }
  if (clause.isTypeOnly) {
    return "type";
  }
  if (clause.name) {
    return "value";
  }

  const bindings = clause.namedBindings;

  if (!bindings) {
    return "value";
  }
  if (ts.isNamespaceImport(bindings)) {
    return "value";
  }
  if (bindings.elements.length === 0) {
    return "value";
  }

  return bindings.elements.every((element) => element.isTypeOnly) ? "type" : "value";
}

/**
 * `export type …`, `export type *`, and an all-`type` named list are type-only.
 * `export *` and a bare namespace re-export carry runtime bindings (or unknown
 * ones), so they classify as value.
 */
function classifyExport(node: ts.ExportDeclaration): EdgeKind {
  if (node.isTypeOnly) {
    return "type";
  }

  const clause = node.exportClause;

  if (!clause) {
    return "value";
  }
  if (ts.isNamespaceExport(clause)) {
    return "value";
  }
  if (clause.elements.length === 0) {
    return "value";
  }

  return clause.elements.every((element) => element.isTypeOnly) ? "type" : "value";
}

/**
 * A dynamic `import()` call. Any arity is accepted: an import-attributes second
 * argument (`import("./x.js", { with: {} })`) does not change the loaded module,
 * and dropping the call would silently lose a real runtime load. The call site
 * still requires `arguments[0]` to be a literal, so undecidable forms stay
 * uncollected instead of being guessed at.
 */
function isDynamicImportCall(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1;
}

/**
 * The literal module reference of `import("…").T` / `typeof import("…")`.
 * `ImportTypeNode` is a type position, so it is a `type` edge — the same class
 * as `import type` / `export type` — never a value load.
 */
function importedTypeLiteral(node: ts.ImportTypeNode): ts.StringLiteralLike | null {
  const argument = node.argument;

  return ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)
    ? argument.literal
    : null;
}

/**
 * Collects every module specifier in source order: static imports (including
 * side-effect imports), `export … from`, literal dynamic `import()` calls, and
 * `import("…").T` type references. The W0 pre-install scanner's discipline (one
 * pass, source order, both quote styles, all forms) is kept, but the AST removes
 * its false positives and is what makes type-only classification possible.
 *
 * Dynamic imports are collected whenever the arity is at least one, so import
 * attributes cannot hide a load; `ImportTypeNode` is classified as `type` so a
 * type-level module reference is visible to the type-edge rules.
 */
export function collectSpecifiers(
  fileName: string,
  sourceText: string,
): readonly CollectedSpecifier[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const collected: CollectedSpecifier[] = [];

  const add = (literal: ts.StringLiteralLike, kind: EdgeKind, positionNode: ts.Node): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(positionNode.getStart(sourceFile));
    collected.push({
      specifier: literal.text,
      kind,
      line: position.line + 1,
      column: position.character + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier, classifyImport(node.importClause), node);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier, classifyExport(node), node);
    } else if (ts.isCallExpression(node) && isDynamicImportCall(node)) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        add(argument, "value", node);
      }
    } else if (ts.isImportTypeNode(node)) {
      const literal = importedTypeLiteral(node);
      if (literal !== null) {
        add(literal, "type", node);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return collected;
}
