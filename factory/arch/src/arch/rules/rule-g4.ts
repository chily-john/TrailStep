import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import {
  buildRuleIndex,
  directChild,
  folderDepth,
  folderOf,
  isInsideFolder,
  type RuleIndex,
} from "./graph-index.js";
import type { Diagnostic } from "./types.js";

function importersOfFolder(index: RuleIndex, folder: string): readonly string[] {
  return index.productionEdges
    .filter((edge) => isInsideFolder(folder, edge.to))
    .map((edge) => edge.from);
}

/**
 * G4 (amended): for a folder F with parent P, the importers of F that live
 * under P must not span more than one direct child of P. Importers outside P
 * are G2/G8 cases and are ignored here. Top-level groups (depth 1) are not NCA
 * cases: their parent is the package root, and rank-0 groups are public leaf
 * modules (parent §12 decision 2).
 */
export function g4NcaViolations(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const diagnostics: Diagnostic[] = [];

  for (const folder of index.folders) {
    if (folder === index.packageRoot || folderDepth(index.packageRoot, folder) < 2) {
      continue;
    }
    const parent = folderOf(folder);
    const children = new Set<string>();
    for (const importer of importersOfFolder(index, folder)) {
      const importerFolder = folderOf(importer);
      if (importerFolder !== parent && !isInsideFolder(parent, importerFolder)) {
        continue;
      }
      children.add(directChild(parent, importer));
    }
    if (children.size > 1) {
      const names = [...children].sort();
      diagnostics.push(
        createDiagnostic(manifest, "G4", {
          file: folder,
          target: names.join(", "),
          message: `importers under ${parent} span ${names.length} direct children (${names.join(", ")}); this private helper is used by siblings.`,
        }),
      );
    }
  }

  return diagnostics;
}

/**
 * The parent work order's pre-exemption NCA candidate count (§8.5): depth-2
 * folders imported from more than one top-level group, with the package-root
 * bucket counted as a group and test importers included. This is the measured
 * evidence-table number (36); it is a trend metric, not the G4 violation list.
 */
export function ncaCandidateCount(graph: ArchGraph, manifest: ArchManifest): number {
  const index = buildRuleIndex(graph, manifest);
  const depth = manifest.conventions.ncaCandidateDepth;
  let count = 0;

  for (const folder of index.folders) {
    if (folderDepth(index.packageRoot, folder) !== depth) {
      continue;
    }
    const topGroups = new Set<string>();
    for (const edge of graph.edges) {
      if (folderOf(edge.to) !== folder) {
        continue;
      }
      topGroups.add(edge.fromGroup ?? manifest.conventions.packageRootBucket);
    }
    if (topGroups.size > 1) {
      count += 1;
    }
  }

  return count;
}
