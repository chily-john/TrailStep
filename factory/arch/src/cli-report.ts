/**
 * Report-mode orchestration: build the rule graph, run the strict set, build
 * the Story 105 scorecard, write the artifact, and render the human summary.
 *
 * The CLI owns the artifact location; the scorecard shape and all measurements
 * stay in `arch/rules/`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ArchGraph } from "./arch/engine/index.js";
import { manifest } from "./arch/manifest.js";
import {
  buildRuleGraph,
  buildScorecard,
  type Diagnostic,
  runRules,
  type Scorecard,
  scorecardJson,
} from "./arch/rules/index.js";

/** Default artifact lives under the gitignored `.trailstep/` run tree. */
export const DEFAULT_SCORECARD_PATH = ".trailstep/arch/architecture-scorecard.json";

export interface ArchReportPaths {
  readonly repoRoot: string;
  readonly tsconfig: string;
}

export interface ArchReport {
  readonly graph: ArchGraph;
  readonly diagnostics: readonly Diagnostic[];
  readonly scorecard: Scorecard;
}

/** The one analyzed tree today: the package tsconfig the manifest ranks cover. */
export function coreTsconfigPath(repoRoot: string): string {
  return path.join(repoRoot, "packages", "core", "tsconfig.json");
}

export function runArchReport(paths: ArchReportPaths): ArchReport {
  const graph = buildRuleGraph({
    projectRoot: paths.repoRoot,
    tsconfig: paths.tsconfig,
    manifest,
  });
  const diagnostics = runRules(graph, manifest);
  return {
    graph,
    diagnostics,
    scorecard: buildScorecard(graph, manifest, diagnostics),
  };
}

export function writeScorecard(scorecard: Scorecard, filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${scorecardJson(scorecard)}\n`, "utf8");
}

function countLabel(count: number, width: number, singular: string, plural: string): string {
  return `${String(count).padStart(width)} ${count === 1 ? singular : plural}`;
}

function ruleLine(scorecard: Scorecard, ruleId: (typeof manifest.ruleOrder)[number]): string {
  const count = scorecard.rules[ruleId];
  return `  ${ruleId.padEnd(4)} ${count.severity.padEnd(6)} ${countLabel(count.violations, 4, "violation", "violations")} / ${countLabel(count.files, 3, "file", "files")}`;
}

/**
 * The human report. It intentionally prints every rule (including zeroes) so
 * the completion record is the first telemetry snapshot the demotion protocol
 * can cite.
 */
export function renderReport(report: ArchReport, scorecardPath: string): string {
  const { scorecard } = report;
  const strictRules = manifest.ruleOrder.filter(
    (ruleId) => manifest.rules[ruleId].severity === "strict",
  );
  const strictTotal = strictRules.reduce(
    (total, ruleId) => total + scorecard.rules[ruleId].violations,
    0,
  );
  const lines = [
    "Architecture scorecard — full tree",
    `Mode: report (never blocks; exit 0)`,
    `Files: ${scorecard.files.total} (${scorecard.files.production} production, ${scorecard.files.tests} test)`,
    `Edges: ${scorecard.edges.total} (${scorecard.edges.production.value} value / ${scorecard.edges.production.type} type; production ${scorecard.edges.production.total}, test ${scorecard.edges.test})`,
    `Resolution errors: ${scorecard.resolutionErrors}`,
    `SCC: value ${scorecard.metrics.scc.value.count} component(s) / ${scorecard.metrics.scc.value.groups} groups; all ${scorecard.metrics.scc.all.count} / ${scorecard.metrics.scc.all.groups}`,
    `NCA: ${scorecard.metrics.nca.candidates} candidates, ${scorecard.metrics.nca.violations} violations`,
    `Folder width: max ${scorecard.metrics.folderWidth.max} at ${scorecard.metrics.folderWidth.maxFolder} (gate ${scorecard.metrics.folderWidth.gate}, target ${scorecard.metrics.folderWidth.target}; ${scorecard.metrics.folderWidth.overGate.length} over gate)`,
    `Cross-group: ${scorecard.metrics.crossGroup.edges} edges, ${scorecard.metrics.crossGroup.pairs} pairs (${scorecard.metrics.crossGroup.downwardPairs} down / ${scorecard.metrics.crossGroup.upwardPairs} up / ${scorecard.metrics.crossGroup.sidewaysPairs} sideways)`,
    "Rules:",
    ...manifest.ruleOrder.map((ruleId) => ruleLine(scorecard, ruleId)),
    `Total strict violations: ${strictTotal}`,
    `Scorecard: ${scorecardPath}`,
  ];
  return `${lines.join("\n")}\n`;
}
