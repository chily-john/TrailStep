import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../../repo/root.js";
import { buildGraph } from "../engine/build-graph.js";
import { manifest } from "../manifest.js";
import { buildRuleGraph } from "./build-rule-graph.js";
import { runRules } from "./run-rules.js";
import { buildScorecard, scorecardJson } from "./scorecard.js";

const REPO_ROOT = findRepoRoot();
const CORE_TSCONFIG = join(REPO_ROOT, "packages", "core", "tsconfig.json");

function buildCoreGraph(includeTests: boolean) {
  return buildGraph({
    projectRoot: REPO_ROOT,
    tsconfig: CORE_TSCONFIG,
    manifest,
    includeTests,
  });
}

/**
 * The evidence table (parent §8.5, re-measured 2026-11-17): 7 groups in one
 * value-edge SCC, 9 groups when type-only edges count, 36 pre-exemption NCA
 * candidates, and `runtime/run-workflow` as the widest folder at 28 direct
 * children. Tests are included for the folder-width and NCA-candidate
 * measurements, exactly like the parent probe's raw tree.
 */
describe("golden scorecard over packages/core/src", () => {
  it("reproduces the evidence table and serializes byte-for-byte identically", () => {
    const firstGraph = buildCoreGraph(true);
    const firstDiagnostics = runRules(firstGraph, manifest);
    const first = buildScorecard(firstGraph, manifest, firstDiagnostics);

    expect(first.files.production).toBe(171);
    expect(first.edges.production).toEqual({ total: 864, value: 472, type: 392 });
    expect(first.metrics.scc.value).toEqual({ count: 1, groups: 7 });
    expect(first.metrics.scc.all).toEqual({ count: 1, groups: 9 });
    expect(first.metrics.nca.candidates).toBe(36);
    expect(first.metrics.folderWidth.max).toBe(28);
    expect(first.metrics.folderWidth.maxFolder).toBe("packages/core/src/runtime/run-workflow");
    expect(first.metrics.folderWidth.gate).toBe(12);
    expect(first.metrics.folderWidth.target).toBe(8);

    const secondGraph = buildCoreGraph(true);
    const second = buildScorecard(secondGraph, manifest, runRules(secondGraph, manifest));
    expect(scorecardJson(second)).toBe(scorecardJson(first));

    console.log(
      `golden scorecard: scc value=${first.metrics.scc.value.groups} ` +
        `all=${first.metrics.scc.all.groups} ` +
        `nca candidates=${first.metrics.nca.candidates} ` +
        `nca violations=${first.metrics.nca.violations} ` +
        `width=${first.metrics.folderWidth.max} ` +
        `cross-group pairs=${first.metrics.crossGroup.pairs}`,
    );
  }, 30_000);

  it("buildRuleGraph includes tests so T-1/T-2 and G5 can see them", () => {
    const graph = buildRuleGraph({
      projectRoot: REPO_ROOT,
      tsconfig: CORE_TSCONFIG,
      manifest,
    });
    expect(graph.files.some((file) => file.path.endsWith(".test.ts"))).toBe(true);
    expect(graph.stats.files).toBeGreaterThan(171);
  }, 30_000);

  it("is red on the current tree by design, with the W6 input counts", () => {
    const graph = buildCoreGraph(true);
    const diagnostics = runRules(graph, manifest);
    const counts = new Map<string, number>();
    for (const diagnostic of diagnostics) {
      counts.set(diagnostic.rule, (counts.get(diagnostic.rule) ?? 0) + 1);
    }

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(counts.get("G1")).toBe(1);
    expect(counts.get("G5")).toBe(4);
    expect(counts.get("G8") ?? 0).toBeGreaterThan(0);

    const snapshot = manifest.ruleOrder
      .filter((ruleId) => counts.has(ruleId))
      .map((ruleId) => `${ruleId}=${counts.get(ruleId) ?? 0}`)
      .join(" ");
    console.log(`real-tree diagnostics (W6 inputs): ${snapshot}`);
  }, 30_000);
});
