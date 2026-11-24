import ts from "typescript";
import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import type { Diagnostic, RuleContext } from "./types.js";

function hasFolderSegment(value: string, name: string): boolean {
  return value.split("/").includes(name);
}

function isProcessIdentifier(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isIdentifier(node) && node.text === "process";
}

function isEnvName(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && node.text === "env";
}

/** Direct `process.env` / `process["env"]`. */
function isProcessEnv(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return isProcessIdentifier(node.expression) && node.name.text === "env";
  }
  if (ts.isElementAccessExpression(node)) {
    return isProcessIdentifier(node.expression) && isEnvName(node.argumentExpression);
  }
  return false;
}

/** `const { env } = process` and its renamed form `const { env: name } = process`. */
function isEnvDestructuring(node: ts.Node): boolean {
  if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name)) {
    return false;
  }
  if (!isProcessIdentifier(node.initializer)) {
    return false;
  }
  return node.name.elements.some((element) => {
    if (!ts.isBindingElement(element) || element.dotDotDotToken !== undefined) {
      return false;
    }
    if (element.propertyName !== undefined) {
      return ts.isIdentifier(element.propertyName) && element.propertyName.text === "env";
    }
    return ts.isIdentifier(element.name) && element.name.text === "env";
  });
}

/** Simple aliases of the process object: `const p = process` → `p`. */
function processAliases(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const aliases = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isProcessIdentifier(node.initializer)) {
        aliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

/** `p.env` / `p["env"]` where `p` is an alias of `process`. */
function isAliasedProcessEnv(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  const isAlias = (expression: ts.Node): boolean =>
    ts.isIdentifier(expression) && aliases.has(expression.text);
  if (ts.isPropertyAccessExpression(node)) {
    return isAlias(node.expression) && node.name.text === "env";
  }
  if (ts.isElementAccessExpression(node)) {
    return isAlias(node.expression) && isEnvName(node.argumentExpression);
  }
  return false;
}

/**
 * M-6 (internal-scoped): no ambient env reads under the internal layer. Biome's
 * `noProcessEnv` owns the rest of the tree (Story 109); this AST copy is the
 * strict internal rule, so it reports direct access, `const { env } = process`
 * destructuring, and aliased access (`const p = process; p.env`).
 *
 * Source text arrives through the injected `RuleContext` seam — the rule never
 * reads the filesystem itself, so the fixture harness can supply the tree
 * in memory and `runRules` supplies the disk reader for a real run.
 */
export function m6AmbientEnv(
  graph: ArchGraph,
  manifest: ArchManifest,
  context: RuleContext,
): Diagnostic[] {
  const { internalFolder, testSuffix } = manifest.conventions;
  const diagnostics: Diagnostic[] = [];

  for (const file of graph.files) {
    if (file.path.endsWith(testSuffix) || !hasFolderSegment(file.path, internalFolder)) {
      continue;
    }
    const sourceText = context.readSource(file.path);
    if (sourceText === undefined) {
      continue;
    }
    const sourceFile = ts.createSourceFile(file.path, sourceText, ts.ScriptTarget.Latest, true);
    const aliases = processAliases(sourceFile);
    const report = (node: ts.Node, message: string): void => {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      diagnostics.push(
        createDiagnostic(manifest, "M-6", {
          file: file.path,
          line: position.line + 1,
          column: position.character + 1,
          target: "process.env",
          message,
        }),
      );
    };
    const visit = (node: ts.Node): void => {
      if (isProcessEnv(node)) {
        report(
          node,
          `reads process.env inside ${internalFolder}/; pass the environment in as a parameter.`,
        );
      } else if (isEnvDestructuring(node)) {
        report(
          node,
          `destructures process.env inside ${internalFolder}/; pass the environment in as a parameter.`,
        );
      } else if (isAliasedProcessEnv(node, aliases)) {
        report(
          node,
          `reads process.env through an alias inside ${internalFolder}/; pass the environment in as a parameter.`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return diagnostics;
}
