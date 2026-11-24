import path from "node:path";
import { isInside } from "./path-utils.js";
import type { EngineManifest, GraphGroup } from "./types.js";

/** The groups in manifest order plus their absolute roots for matching. */
export interface GroupIndex {
  readonly groups: readonly GraphGroup[];
  readonly roots: readonly { readonly root: string; readonly group: GraphGroup }[];
}

/**
 * Derives the group table from the manifest's ranked layers and unranked
 * groups. A group's rank is its layer's rank; its `layerIndex` is its
 * `targetGroup`'s position in the flattened `docGroups` order, which is the
 * layer list G2 uses. An unranked group has neither.
 */
export function buildGroupIndex(manifest: EngineManifest, projectRoot: string): GroupIndex {
  const layerOrder = manifest.ranks.flatMap((layer) => layer.docGroups);
  const layerIndexByTargetGroup = new Map<string, number>();
  for (const [index, targetGroup] of layerOrder.entries()) {
    if (!layerIndexByTargetGroup.has(targetGroup)) {
      layerIndexByTargetGroup.set(targetGroup, index);
    }
  }

  const groups: GraphGroup[] = [];

  for (const layer of manifest.ranks) {
    for (const group of layer.groups) {
      groups.push({
        name: group.name,
        root: group.root,
        rank: layer.rank,
        layerIndex: layerIndexByTargetGroup.get(group.targetGroup) ?? null,
        targetGroup: group.targetGroup,
      });
    }
  }

  for (const group of manifest.unrankedGroups) {
    groups.push({
      name: group.name,
      root: group.root,
      rank: null,
      layerIndex: null,
      targetGroup: group.targetGroup,
    });
  }

  return {
    groups,
    roots: groups.map((group) => ({ root: path.resolve(projectRoot, group.root), group })),
  };
}

/**
 * A file belongs to the deepest declared group root that contains it; a file at
 * any depth under a root belongs to that root's group. Files outside every root
 * — the package's `src/` root files, for example — go to the ungrouped bucket
 * (`null`), matching the parent probe's `(root)` exclusion from the group graph.
 */
export function groupForFile(index: GroupIndex, absoluteFile: string): GraphGroup | null {
  let best: { readonly rootLength: number; readonly group: GraphGroup } | null = null;

  for (const candidate of index.roots) {
    if (!isInside(candidate.root, absoluteFile)) {
      continue;
    }
    if (best === null || candidate.root.length > best.rootLength) {
      best = { rootLength: candidate.root.length, group: candidate.group };
    }
  }

  return best?.group ?? null;
}
