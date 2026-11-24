import path from "node:path";
import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import { buildRuleIndex, isFixturePath, type RuleIndex } from "./graph-index.js";
import type { Diagnostic } from "./types.js";

function hasFolderSegment(value: string, name: string): boolean {
  return value.split("/").includes(name);
}

/** S-5: capability folders, never technical-role names. */
export function s5BannedFolderNames(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const banned = new Set(manifest.conventions.bannedFolderNames);
  const diagnostics: Diagnostic[] = [];

  for (const folder of index.folders) {
    if (isFixturePath(index, folder)) {
      continue;
    }
    const name = path.posix.basename(folder);
    if (banned.has(name)) {
      diagnostics.push(
        createDiagnostic(manifest, "S-5", {
          file: folder,
          target: name,
          message: `folder "${name}" names a technical role, not a capability, adapter, or store.`,
        }),
      );
    }
  }

  return diagnostics;
}

/** S-6: the arrow is one-way; nothing under the internal layer may import the public surface. */
export function s6InternalImportsSurface(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const { internalFolder, publicSurfaceFolder } = manifest.conventions;
  const diagnostics: Diagnostic[] = [];

  for (const edge of index.productionEdges) {
    if (
      hasFolderSegment(edge.from, internalFolder) &&
      hasFolderSegment(edge.to, publicSurfaceFolder)
    ) {
      diagnostics.push(
        createDiagnostic(manifest, "S-6", {
          file: edge.from,
          line: edge.line,
          column: edge.column,
          target: edge.to,
          message: `imports the public surface (${publicSurfaceFolder}/) from inside ${internalFolder}/; the arrow must point inward.`,
        }),
      );
    }
  }

  return diagnostics;
}

/** S-9: a folder with one child folder and no files is a missing level. */
export function s9MissingLevel(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index: RuleIndex = buildRuleIndex(graph, manifest);
  const diagnostics: Diagnostic[] = [];

  for (const folder of index.folders) {
    if (folder === index.packageRoot || isFixturePath(index, folder)) {
      continue;
    }
    const children = index.children.get(folder);
    if (children !== undefined && children.files.length === 0 && children.folders.length === 1) {
      const onlyChild = children.folders[0] ?? "";
      diagnostics.push(
        createDiagnostic(manifest, "S-9", {
          file: folder,
          target: onlyChild,
          message: `has exactly one child folder (${onlyChild}) and no files; fold the missing level up.`,
        }),
      );
    }
  }

  return diagnostics;
}
