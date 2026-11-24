import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import type { Diagnostic } from "./types.js";

/** Unordered key for a §8.1 forbidden peer pair. */
function peerPairKey(left: string, right: string): string {
  return [left, right].sort().join("\u0000");
}

/**
 * G2 (amended G-3): every import — value or type-only — must point to a group
 * earlier in the manifest's flattened layer order. A lower rank importing an
 * upper rank is the violation; a same-layer import is legal UNLESS the manifest
 * closes that rank's band with a `forbiddenPeers` pair.
 *
 * §8.1 closes rank 2 (`providers`/`run-store`, "May import 0–1") and rank 3
 * (`execution`/`evidence`, "May import 0–2"; `execution ↮ evidence` — "never,
 * in either direction", "the write path never imports the read path"). The
 * pairs are manifest data, so the reverse direction of each pair — which the
 * flattened order alone would allow — is still a violation.
 *
 * An unranked group is a leaf with an explicit import-rank allowlist
 * (`deprecations` may import rank 0); an edge out of that allowlist is the same
 * direction violation expressed through the manifest's unranked record.
 */
export function g2UpwardImports(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const groupByName = new Map(graph.groups.map((group) => [group.name, group]));
  const unrankedByName = new Map<string, (typeof manifest.unrankedGroups)[number]>(
    manifest.unrankedGroups.map((group) => [group.name, group]),
  );
  const forbiddenPeers = new Set(
    manifest.ranks.flatMap((layer) =>
      layer.forbiddenPeers.map((pair) => peerPairKey(pair.from, pair.to)),
    ),
  );
  const diagnostics: Diagnostic[] = [];

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

    const from = groupByName.get(edge.fromGroup);
    const to = groupByName.get(edge.toGroup);
    if (from === undefined || to === undefined) {
      continue;
    }

    if (from.layerIndex !== null && to.layerIndex !== null) {
      if (
        from.targetGroup !== to.targetGroup &&
        forbiddenPeers.has(peerPairKey(from.targetGroup, to.targetGroup))
      ) {
        diagnostics.push(
          createDiagnostic(manifest, "G2", {
            file: edge.from,
            line: edge.line,
            column: edge.column,
            target: edge.to,
            message: `imports ${from.name} → ${to.name} (both rank ${from.rank}); ${from.targetGroup} and ${to.targetGroup} may not import each other.`,
          }),
        );
        continue;
      }
      if (to.layerIndex > from.layerIndex) {
        diagnostics.push(
          createDiagnostic(manifest, "G2", {
            file: edge.from,
            line: edge.line,
            column: edge.column,
            target: edge.to,
            message: `imports ${from.name} → ${to.name} (layer ${from.layerIndex} → ${to.layerIndex}); imports may only point to an earlier layer.`,
          }),
        );
      }
      continue;
    }

    if (from.layerIndex === null && to.rank !== null) {
      const unranked = unrankedByName.get(from.name);
      if (unranked !== undefined && !unranked.allowedImportRanks.some((rank) => rank === to.rank)) {
        diagnostics.push(
          createDiagnostic(manifest, "G2", {
            file: edge.from,
            line: edge.line,
            column: edge.column,
            target: edge.to,
            message: `imports rank ${to.rank} (${to.name}) from unranked ${from.name}; only rank ${unranked.allowedImportRanks.join(", ")} may be imported.`,
          }),
        );
      }
    }
  }

  return diagnostics;
}
