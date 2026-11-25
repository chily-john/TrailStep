import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest, RuleId } from "../manifest.js";
import { buildRuleIndex } from "./graph-index.js";
import { computeGroupSccs, computeOwnerSccs, groupSccMetric, ownerSccMetric } from "./rule-g1.js";
import { type CrossGroupMetric, g3CrossGroupMetric } from "./rule-g3.js";
import { ncaCandidateCount } from "./rule-g4.js";
import { measureFolderWidths } from "./rule-g5.js";
import type { Diagnostic } from "./types.js";

export interface RuleCount {
  readonly severity: string;
  readonly violations: number;
  readonly files: number;
}

export interface WidthEntry {
  readonly folder: string;
  readonly width: number;
}

export interface FolderWidthMetric {
  readonly gate: number;
  readonly target: number;
  readonly max: number;
  readonly maxFolder: string;
  readonly overGate: readonly WidthEntry[];
  readonly overTarget: readonly WidthEntry[];
}

export interface ScorecardMetrics {
  readonly scc: {
    readonly value: { readonly count: number; readonly groups: number };
    readonly all: { readonly count: number; readonly groups: number };
    /** Owner-folder SCCs are separate telemetry; group counts stay historical. */
    readonly owners: {
      readonly value: { readonly count: number; readonly folders: number };
      readonly all: { readonly count: number; readonly folders: number };
    };
  };
  readonly nca: { readonly candidates: number; readonly violations: number };
  readonly folderWidth: FolderWidthMetric;
  readonly crossGroup: CrossGroupMetric;
  readonly ungrouped: {
    readonly files: number;
    readonly valueEdgesOut: number;
    readonly typeEdgesOut: number;
  };
}

/** The serialization-safe report Story 106 writes and Story 107 uploads. */
export interface Scorecard {
  readonly schemaVersion: 1;
  readonly files: { readonly total: number; readonly production: number; readonly tests: number };
  readonly edges: {
    readonly total: number;
    readonly production: { readonly total: number; readonly value: number; readonly type: number };
    readonly test: number;
  };
  readonly resolutionErrors: number;
  readonly rules: Readonly<Record<RuleId, RuleCount>>;
  readonly metrics: ScorecardMetrics;
}

function ruleCounts(
  manifest: ArchManifest,
  diagnostics: readonly Diagnostic[],
): Record<RuleId, RuleCount> {
  const counts = {} as Record<RuleId, RuleCount>;
  for (const ruleId of manifest.ruleOrder) {
    const matching = diagnostics.filter((diagnostic) => diagnostic.rule === ruleId);
    counts[ruleId] = {
      severity: manifest.rules[ruleId].severity,
      violations: matching.length,
      files: new Set(matching.map((diagnostic) => diagnostic.file)).size,
    };
  }
  return counts;
}

function widthMetric(
  index: ReturnType<typeof buildRuleIndex>,
  manifest: ArchManifest,
): FolderWidthMetric {
  const { gate, target } = manifest.budgets.folderWidth;
  const widths = measureFolderWidths(index).sort(
    (left, right) =>
      right.width - left.width ||
      (left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0),
  );
  const widest = widths[0] ?? { folder: "", width: 0 };
  return {
    gate,
    target,
    max: widest.width,
    maxFolder: widest.folder,
    overGate: widths.filter((entry) => entry.width > gate),
    overTarget: widths.filter((entry) => entry.width > target),
  };
}

function ungroupedMetric(graph: ArchGraph): ScorecardMetrics["ungrouped"] {
  let valueEdgesOut = 0;
  let typeEdgesOut = 0;
  for (const edge of graph.edges) {
    if (edge.fromGroup !== null) {
      continue;
    }
    if (edge.kind === "value") {
      valueEdgesOut += 1;
    } else {
      typeEdgesOut += 1;
    }
  }
  return {
    files: graph.files.filter((file) => file.group === null).length,
    valueEdgesOut,
    typeEdgesOut,
  };
}

/**
 * Builds the deterministic scorecard from the graph, the manifest, and the
 * violations. All arrays are sorted and all keys follow the manifest's rule
 * order, so the JSON is byte-stable across runs and machines.
 */
export function buildScorecard(
  graph: ArchGraph,
  manifest: ArchManifest,
  diagnostics: readonly Diagnostic[],
): Scorecard {
  const index = buildRuleIndex(graph, manifest);
  const production = index.productionFiles.length;
  const tests = index.testFiles.length;
  const scc = groupSccMetric(computeGroupSccs(graph, manifest));
  const owners = ownerSccMetric(computeOwnerSccs(graph, manifest));
  const g4Violations = diagnostics.filter((diagnostic) => diagnostic.rule === "G4").length;
  const productionEdges = index.productionEdges;

  return {
    schemaVersion: 1,
    files: { total: graph.files.length, production, tests },
    edges: {
      total: graph.stats.edges,
      production: {
        total: productionEdges.length,
        value: productionEdges.filter((edge) => edge.kind === "value").length,
        type: productionEdges.filter((edge) => edge.kind === "type").length,
      },
      test: graph.stats.edges - productionEdges.length,
    },
    resolutionErrors: graph.stats.resolutionErrors,
    rules: ruleCounts(manifest, diagnostics),
    metrics: {
      scc: { ...scc, owners },
      nca: { candidates: ncaCandidateCount(graph, manifest), violations: g4Violations },
      folderWidth: widthMetric(index, manifest),
      crossGroup: g3CrossGroupMetric(graph, manifest),
      ungrouped: ungroupedMetric(graph),
    },
  };
}

/** The byte-stable JSON form (pretty-printed for diffable artifacts). */
export function scorecardJson(scorecard: Scorecard): string {
  return JSON.stringify(scorecard, null, 2);
}
