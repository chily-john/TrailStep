import path from "node:path";
import ts from "typescript";
import { collectSpecifiers } from "./collect-specifiers.js";
import { buildGroupIndex, groupForFile } from "./groups.js";
import { compareStrings, relativePosixPath } from "./path-utils.js";
import { createResolutionCache, resolveSpecifier } from "./resolve-specifiers.js";
import { collectSourceFiles, loadTsconfig } from "./tsconfig.js";
import type {
  ArchGraph,
  BuildGraphOptions,
  GraphEdge,
  GraphFile,
  GraphGroup,
  ResolutionError,
} from "./types.js";

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return (
    compareStrings(left.from, right.from) ||
    compareStrings(left.to, right.to) ||
    left.line - right.line ||
    left.column - right.column ||
    compareStrings(left.specifier, right.specifier) ||
    compareStrings(left.kind, right.kind)
  );
}

function compareResolutionErrors(left: ResolutionError, right: ResolutionError): number {
  return (
    compareStrings(left.from, right.from) ||
    left.line - right.line ||
    left.column - right.column ||
    compareStrings(left.specifier, right.specifier)
  );
}

/**
 * Builds the architecture graph for one tsconfig.
 *
 * Edge model: one edge per import/export specifier occurrence. An edge exists
 * only when the specifier resolves to a file in the analyzed set; imports of
 * node builtins, packages, or build output are not architecture edges (they
 * have no group on both ends). An unresolved relative path or undeclared
 * package is not dropped — it is a `ResolutionError`.
 *
 * Determinism: files are sorted before analysis and edges/errors are sorted
 * afterwards, so the same tree always serializes byte-for-byte identically.
 */
export function buildGraph(options: BuildGraphOptions): ArchGraph {
  const projectRoot = path.resolve(options.projectRoot);
  const loaded = loadTsconfig(options.tsconfig);
  const sourceFiles = collectSourceFiles(loaded, projectRoot, options.includeTests ?? false);
  const fileSet = new Set(sourceFiles);
  const groupIndex = buildGroupIndex(options.manifest, projectRoot);
  const cache = createResolutionCache(projectRoot, loaded.options);

  // Resolve every file's group once; edge lookups then stay cheap and do not
  // re-walk the group table for each of the ~900 specifiers.
  const groupByFile = new Map<string, GraphGroup | null>();
  for (const absoluteFile of sourceFiles) {
    groupByFile.set(absoluteFile, groupForFile(groupIndex, absoluteFile));
  }

  const files: GraphFile[] = [];
  const edges: GraphEdge[] = [];
  const resolutionErrors: ResolutionError[] = [];

  for (const absoluteFile of sourceFiles) {
    const sourceText = ts.sys.readFile(absoluteFile);
    if (sourceText === undefined) {
      throw new Error(`Cannot read source file "${absoluteFile}".`);
    }

    const filePath = relativePosixPath(projectRoot, absoluteFile);
    const group = groupByFile.get(absoluteFile) ?? null;

    files.push({
      path: filePath,
      group: group?.name ?? null,
      rank: group?.rank ?? null,
      layerIndex: group?.layerIndex ?? null,
      targetGroup: group?.targetGroup ?? null,
    });

    for (const specifier of collectSpecifiers(absoluteFile, sourceText)) {
      const outcome = resolveSpecifier(specifier.specifier, absoluteFile, loaded.options, cache);
      const target = outcome.resolvedPath;

      if (target !== null && fileSet.has(target)) {
        const targetGroup = groupByFile.get(target) ?? null;
        edges.push({
          from: filePath,
          to: relativePosixPath(projectRoot, target),
          specifier: specifier.specifier,
          kind: specifier.kind,
          line: specifier.line,
          column: specifier.column,
          fromGroup: group?.name ?? null,
          toGroup: targetGroup?.name ?? null,
        });
      } else if (target === null && !outcome.external) {
        resolutionErrors.push({
          from: filePath,
          specifier: specifier.specifier,
          kind: specifier.kind,
          line: specifier.line,
          column: specifier.column,
          reason: outcome.reason ?? "unresolved module",
        });
      }
    }
  }

  edges.sort(compareEdges);
  resolutionErrors.sort(compareResolutionErrors);

  return {
    projectRoot,
    files,
    edges,
    groups: groupIndex.groups,
    resolutionErrors,
    stats: {
      files: files.length,
      edges: edges.length,
      valueEdges: edges.filter((edge) => edge.kind === "value").length,
      typeEdges: edges.filter((edge) => edge.kind === "type").length,
      resolutionErrors: resolutionErrors.length,
    },
  };
}
