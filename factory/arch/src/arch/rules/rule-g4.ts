import path from "node:path";
import type { ArchGraph, GraphEdge } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import {
  buildRuleIndex,
  directChild,
  folderDepth,
  folderOf,
  frontDoorBasename,
  isInsideFolder,
  type RuleIndex,
} from "./graph-index.js";
import type { Diagnostic } from "./types.js";

/**
 * The G4 qualifying edge: a non-test import into `folder` that targets a file
 * other than the folder's own front door and starts OUTSIDE `folder`. A
 * front-door import is explicit module composition, and an import between two
 * files inside the owner folder is the owner's own implementation: neither is
 * a reach-in, and neither can make the folder an NCA case. A parent-level
 * barrel is not a front door for the child either.
 *
 * Exported so `--changed` ratchets on exactly the edge set this rule counts,
 * never on a broader "any import into the folder" predicate.
 */
export function isG4ReachIn(index: RuleIndex, folder: string, edge: GraphEdge): boolean {
  const testSuffix = index.manifest.conventions.testSuffix;
  if (edge.from.endsWith(testSuffix) || edge.to.endsWith(testSuffix)) {
    return false;
  }
  if (!isInsideFolder(folder, edge.to)) {
    return false;
  }
  // Glossary reach-in: an import from OUTSIDE the owner folder. An intra-owner
  // edge is the folder's own implementation, never a sibling reach-in.
  if (isInsideFolder(folder, edge.from)) {
    return false;
  }
  return path.posix.basename(edge.to) !== frontDoorBasename(index, folder);
}

/** True when `folder` is a group root or lives below one. */
function isInsideAGroup(index: RuleIndex, folder: string): boolean {
  return index.graph.groups.some(
    (group) => folder === group.root || isInsideFolder(group.root, folder),
  );
}

/**
 * G4's scope: the flagged folder's parent must be a group root or a folder
 * below one. A top-level group's parent is the package root, so top-level
 * groups are never G4 cases; relationships between them are G2/G3/G8.
 */
export function isG4ScopeFolder(index: RuleIndex, folder: string): boolean {
  return folder !== index.packageRoot && isInsideAGroup(index, folderOf(folder));
}

/**
 * G4 (amended): for an owner folder F with parent P inside a group, the
 * non-front-door importers of F that live under P must not span more than one
 * direct child of P. Importers outside P are G2/G8 cases and are ignored here.
 * Imports through F's derived `<F>.ts` or declared `<F>.types.ts` front door are
 * composition, not reach-ins, and neither are imports inside F itself. G4
 * applies only below a group root: top-level groups are never G4 cases, and
 * there is no rank-0 exemption for folders below a group.
 */
export function g4NcaViolations(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const diagnostics: Diagnostic[] = [];

  for (const folder of index.folders) {
    if (!isG4ScopeFolder(index, folder)) {
      continue;
    }
    const parent = folderOf(folder);
    const children = new Set<string>();
    for (const edge of index.productionEdges) {
      if (!isG4ReachIn(index, folder, edge)) {
        continue;
      }
      const importerFolder = folderOf(edge.from);
      if (importerFolder !== parent && !isInsideFolder(parent, importerFolder)) {
        continue;
      }
      children.add(directChild(parent, edge.from));
    }
    if (children.size > 1) {
      const names = [...children].sort();
      diagnostics.push(
        createDiagnostic(manifest, "G4", {
          file: folder,
          target: names.join(", "),
          message: `private helper shared by sibling areas: non-front-door importers under ${parent} span ${names.length} direct children (${names.join(", ")}).`,
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
