import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import { componentMembership, stronglyConnectedComponents } from "./scc.js";
import type { Diagnostic } from "./types.js";

/** The two SCC views the scorecard reports: value-only and all edges (G-2a). */
export interface GroupSccResult {
  readonly value: string[][];
  readonly all: string[][];
}

function groupEdges(
  graph: ArchGraph,
  manifest: ArchManifest,
  kind: "value" | "all",
): readonly (readonly [string, string])[] {
  const edges: (readonly [string, string])[] = [];
  for (const edge of graph.edges) {
    if (edge.fromGroup === null || edge.toGroup === null) {
      continue;
    }
    if (
      edge.from.endsWith(manifest.conventions.testSuffix) ||
      edge.to.endsWith(manifest.conventions.testSuffix)
    ) {
      continue;
    }
    if (kind === "value" && edge.kind !== "value") {
      continue;
    }
    edges.push([edge.fromGroup, edge.toGroup]);
  }
  return edges;
}

/**
 * G1 (amended G-2a): folder-level cycles over the manifest's top-level groups,
 * counting value and type-only edges. The value-only view is kept for the
 * scorecard's diagnosis split; the all-edge view is the violation list. Test
 * files are excluded, exactly like the measured parent graph.
 */
export function computeGroupSccs(graph: ArchGraph, manifest: ArchManifest): GroupSccResult {
  const nodes = graph.groups.map((group) => group.name);
  return {
    value: stronglyConnectedComponents(nodes, groupEdges(graph, manifest, "value")),
    all: stronglyConnectedComponents(nodes, groupEdges(graph, manifest, "all")),
  };
}

/** Membership totals for the scorecard (7 value / 9 all on the measured tree). */
export function groupSccMetric(result: GroupSccResult): {
  readonly value: { readonly count: number; readonly groups: number };
  readonly all: { readonly count: number; readonly groups: number };
} {
  return {
    value: { count: result.value.length, groups: componentMembership(result.value) },
    all: { count: result.all.length, groups: componentMembership(result.all) },
  };
}

/** One diagnostic per all-edge SCC, naming its complete membership. */
export function g1GroupCycles(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const rootByGroup = new Map(graph.groups.map((group) => [group.name, group.root]));
  return computeGroupSccs(graph, manifest).all.map((members) =>
    createDiagnostic(manifest, "G1", {
      file: rootByGroup.get(members[0] ?? "") ?? members[0] ?? "",
      target: members.join(", "),
      message: `folder cycle across ${members.length} groups: ${members.join(", ")}.`,
    }),
  );
}
