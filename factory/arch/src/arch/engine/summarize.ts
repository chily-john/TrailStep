import type { ArchGraph } from "./types.js";

/** Per-group counts in the deterministic summary. */
export interface GroupSummary {
  readonly name: string;
  readonly root: string;
  readonly rank: number | null;
  readonly layerIndex: number | null;
  readonly targetGroup: string;
  readonly files: number;
  readonly valueEdgesOut: number;
  readonly typeEdgesOut: number;
}

/**
 * A serialization-safe view of the graph: totals plus per-group counts, in
 * manifest order. It contains no absolute paths, so the JSON is stable across
 * machines and can be compared byte-for-byte between runs (the golden test).
 */
export interface GraphSummary {
  readonly files: number;
  readonly edges: number;
  readonly valueEdges: number;
  readonly typeEdges: number;
  readonly resolutionErrors: number;
  readonly ungroupedFiles: number;
  readonly ungroupedValueEdgesOut: number;
  readonly ungroupedTypeEdgesOut: number;
  readonly groups: readonly GroupSummary[];
}

/** The JSON edge summary every later story compares against. */
export function summarizeGraph(graph: ArchGraph): GraphSummary {
  const filesByGroup = new Map<string, number>();
  let ungroupedFiles = 0;

  for (const file of graph.files) {
    if (file.group === null) {
      ungroupedFiles += 1;
    } else {
      filesByGroup.set(file.group, (filesByGroup.get(file.group) ?? 0) + 1);
    }
  }

  const outByGroup = new Map<string, { value: number; type: number }>();
  let ungroupedValueEdgesOut = 0;
  let ungroupedTypeEdgesOut = 0;

  for (const edge of graph.edges) {
    if (edge.fromGroup === null) {
      if (edge.kind === "value") {
        ungroupedValueEdgesOut += 1;
      } else {
        ungroupedTypeEdgesOut += 1;
      }
      continue;
    }
    const counts = outByGroup.get(edge.fromGroup) ?? { value: 0, type: 0 };
    if (edge.kind === "value") {
      counts.value += 1;
    } else {
      counts.type += 1;
    }
    outByGroup.set(edge.fromGroup, counts);
  }

  const groups = graph.groups.map((group) => ({
    name: group.name,
    root: group.root,
    rank: group.rank,
    layerIndex: group.layerIndex,
    targetGroup: group.targetGroup,
    files: filesByGroup.get(group.name) ?? 0,
    valueEdgesOut: outByGroup.get(group.name)?.value ?? 0,
    typeEdgesOut: outByGroup.get(group.name)?.type ?? 0,
  }));

  return {
    files: graph.stats.files,
    edges: graph.stats.edges,
    valueEdges: graph.stats.valueEdges,
    typeEdges: graph.stats.typeEdges,
    resolutionErrors: graph.stats.resolutionErrors,
    ungroupedFiles,
    ungroupedValueEdgesOut,
    ungroupedTypeEdgesOut,
    groups,
  };
}
