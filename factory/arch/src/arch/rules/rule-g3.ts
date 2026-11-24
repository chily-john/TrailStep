import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";

/** G3 is a trend metric, never a pass/fail list: distinct cross-group edges. */
export interface CrossGroupMetric {
  readonly edges: number;
  readonly pairs: number;
  readonly downwardPairs: number;
  readonly upwardPairs: number;
  readonly sidewaysPairs: number;
}

/**
 * G3: distinct group→group imports (value or type-only), test edges excluded.
 * A pair is classified by the layer order so the report shows whether the
 * trend is moving toward the layering target.
 */
export function g3CrossGroupMetric(graph: ArchGraph, manifest: ArchManifest): CrossGroupMetric {
  const layerByName = new Map(graph.groups.map((group) => [group.name, group.layerIndex]));
  const pairs = new Set<string>();
  const downward = new Set<string>();
  const upward = new Set<string>();
  const sideways = new Set<string>();
  let edges = 0;

  for (const edge of graph.edges) {
    if (edge.fromGroup === null || edge.toGroup === null || edge.fromGroup === edge.toGroup) {
      continue;
    }
    if (
      edge.from.endsWith(manifest.conventions.testSuffix) ||
      edge.to.endsWith(manifest.conventions.testSuffix)
    ) {
      continue;
    }
    edges += 1;
    const key = `${edge.fromGroup}→${edge.toGroup}`;
    pairs.add(key);
    const fromLayer = layerByName.get(edge.fromGroup) ?? null;
    const toLayer = layerByName.get(edge.toGroup) ?? null;
    if (fromLayer !== null && toLayer !== null && toLayer > fromLayer) {
      upward.add(key);
    } else if (fromLayer !== null && toLayer !== null && toLayer < fromLayer) {
      downward.add(key);
    } else {
      sideways.add(key);
    }
  }

  return {
    edges,
    pairs: pairs.size,
    downwardPairs: downward.size,
    upwardPairs: upward.size,
    sidewaysPairs: sideways.size,
  };
}
