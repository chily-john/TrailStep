import path from "node:path";
import type { ArchGraph, GraphEdge } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import { componentMembership, stronglyConnectedComponents } from "./scc.js";
import type { Diagnostic } from "./types.js";

/**
 * The two SCC views the scorecard reports for each graph: value-only and all
 * edges (G-2a). The owner view is the same shape keyed by owner folder.
 */
export interface SccResult {
  readonly value: string[][];
  readonly all: string[][];
}

/** Historical name kept for the group SCC view. */
export type GroupSccResult = SccResult;

type CycleView = "value" | "all";

/** Production edges for one view: tests excluded, type-only optional. */
function productionCycleEdges(
  graph: ArchGraph,
  manifest: ArchManifest,
  view: CycleView,
): readonly GraphEdge[] {
  const testSuffix = manifest.conventions.testSuffix;
  return graph.edges.filter((edge) => {
    if (edge.from.endsWith(testSuffix) || edge.to.endsWith(testSuffix)) {
      return false;
    }
    return view === "all" || edge.kind === "value";
  });
}

function groupEdges(
  graph: ArchGraph,
  manifest: ArchManifest,
  view: CycleView,
): readonly (readonly [string, string])[] {
  return productionCycleEdges(graph, manifest, view)
    .filter((edge) => edge.fromGroup !== null && edge.toGroup !== null)
    .map((edge) => [edge.fromGroup ?? "", edge.toGroup ?? ""] as const);
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

/** One group's owner-folder SCC view; group roots are disjoint by construction. */
export interface OwnerSccBreakdown {
  readonly group: string;
  readonly root: string;
  readonly value: string[][];
  readonly all: string[][];
}

function isInside(folder: string, value: string): boolean {
  return value.startsWith(`${folder}/`);
}

function componentsByFirstMember(components: readonly (readonly string[])[]): string[][] {
  return components
    .map((component) => [...component])
    .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

/** Every owner folder: the immediate dirname of a production source file. */
function ownerNodes(graph: ArchGraph, manifest: ArchManifest): string[] {
  const testSuffix = manifest.conventions.testSuffix;
  return [
    ...new Set(
      graph.files
        .filter((file) => !file.path.endsWith(testSuffix))
        .map((file) => path.posix.dirname(file.path)),
    ),
  ].sort();
}

/**
 * Owner-folder edges: a production file edge A→B becomes an owner edge when the
 * two files live in different folders. Edges inside one owner folder never make
 * an owner-folder cycle.
 */
function ownerEdges(
  graph: ArchGraph,
  manifest: ArchManifest,
  view: CycleView,
): readonly (readonly [string, string])[] {
  const edges: (readonly [string, string])[] = [];
  for (const edge of productionCycleEdges(graph, manifest, view)) {
    const fromOwner = path.posix.dirname(edge.from);
    const toOwner = path.posix.dirname(edge.to);
    if (fromOwner !== toOwner) {
      edges.push([fromOwner, toOwner]);
    }
  }
  return edges;
}

/**
 * G-2a's owner-folder view, computed independently inside each top-level
 * group. A cycle between folders nested in one group (for example
 * `contracts/agents ↮ contracts/run-context`) is invisible to the group graph,
 * so it gets its own SCC computation. A cycle that spans two top-level groups
 * is the group SCC's job: restricting each computation to one group's root
 * means that cross-group cycle is never duplicated as an owner diagnostic.
 * Value and type-only edges both count; tests are excluded consistently.
 */
export function computeOwnerSccsByGroup(
  graph: ArchGraph,
  manifest: ArchManifest,
): OwnerSccBreakdown[] {
  const nodes = ownerNodes(graph, manifest);
  const valueEdges = ownerEdges(graph, manifest, "value");
  const allEdges = ownerEdges(graph, manifest, "all");

  return [...graph.groups]
    .sort((left, right) => left.root.localeCompare(right.root))
    .map((group) => {
      const groupNodes = nodes.filter((node) => node === group.root || isInside(group.root, node));
      const nodeSet = new Set(groupNodes);
      const edgesInGroup = (
        edges: readonly (readonly [string, string])[],
      ): readonly (readonly [string, string])[] =>
        edges.filter(([from, to]) => nodeSet.has(from) && nodeSet.has(to));
      return {
        group: group.name,
        root: group.root,
        value: stronglyConnectedComponents(groupNodes, edgesInGroup(valueEdges)),
        all: stronglyConnectedComponents(groupNodes, edgesInGroup(allEdges)),
      };
    });
}

/** The per-group owner components, flattened into the scorecard's two views. */
export function computeOwnerSccs(graph: ArchGraph, manifest: ArchManifest): SccResult {
  const perGroup = computeOwnerSccsByGroup(graph, manifest);
  return {
    value: componentsByFirstMember(perGroup.flatMap((entry) => entry.value)),
    all: componentsByFirstMember(perGroup.flatMap((entry) => entry.all)),
  };
}

/** Owner SCC telemetry, reported alongside (never instead of) group counts. */
export function ownerSccMetric(result: SccResult): {
  readonly value: { readonly count: number; readonly folders: number };
  readonly all: { readonly count: number; readonly folders: number };
} {
  return {
    value: { count: result.value.length, folders: componentMembership(result.value) },
    all: { count: result.all.length, folders: componentMembership(result.all) },
  };
}

/** One diagnostic per group SCC, naming its complete membership. */
export function g1GroupCycles(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const rootByGroup = new Map(graph.groups.map((group) => [group.name, group.root]));
  return computeGroupSccs(graph, manifest).all.map((members) =>
    createDiagnostic(manifest, "G1", {
      file: rootByGroup.get(members[0] ?? "") ?? members[0] ?? "",
      target: members.join(", "),
      targetKind: "group",
      message: `folder cycle across ${members.length} groups: ${members.join(", ")}.`,
    }),
  );
}

/**
 * One diagnostic per owner-folder SCC in each group's owner graph. The group
 * name is part of the message so a same-named owner in another group can never
 * be confused with this component.
 */
export function g1OwnerCycles(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const entry of computeOwnerSccsByGroup(graph, manifest)) {
    for (const members of entry.all) {
      diagnostics.push(
        createDiagnostic(manifest, "G1", {
          file: members[0] ?? "",
          target: members.join(", "),
          targetKind: "owner",
          message: `owner-folder cycle in group ${entry.group} across ${members.length} owner folders: ${members.join(", ")}.`,
        }),
      );
    }
  }
  return diagnostics;
}

/**
 * G1's full violation list: one deterministic diagnostic per group SCC and one
 * per owner-folder SCC inside each group's owner graph. They are deliberately
 * separate rows — the group view is the historical telemetry, the owner view is
 * the nested-cycle gate.
 */
export function g1Cycles(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  return [...g1GroupCycles(graph, manifest), ...g1OwnerCycles(graph, manifest)];
}
