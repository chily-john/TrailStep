import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import { buildRuleIndex, countedChildren, isFixturePath, type RuleIndex } from "./graph-index.js";
import type { Diagnostic } from "./types.js";

/** One folder's measured width, sorted by folder path for stable output. */
export interface FolderWidth {
  readonly folder: string;
  readonly width: number;
}

/** All measured folder widths, excluding fixture subtrees. */
export function measureFolderWidths(index: RuleIndex): FolderWidth[] {
  return index.folders
    .filter((folder) => !isFixturePath(index, folder))
    .map((folder) => {
      const children = countedChildren(index, folder);
      return { folder, width: children.files.length + children.folders.length };
    })
    .sort((left, right) => (left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0));
}

/**
 * G5: direct children (files + folders, tests included) per folder. Fixture
 * entries are excluded. A violation is above the manifest's gate (12); the
 * target (8) is reported in the scorecard, not used to fail the rule.
 */
export function g5FolderWidth(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const gate = manifest.budgets.folderWidth.gate;
  const target = manifest.budgets.folderWidth.target;

  return measureFolderWidths(index)
    .filter((entry) => entry.width > gate)
    .map((entry) =>
      createDiagnostic(manifest, "G5", {
        file: entry.folder,
        target: `${entry.width} direct children`,
        message: `has ${entry.width} direct children; the gate is ${gate} and the target is ${target}.`,
      }),
    );
}
