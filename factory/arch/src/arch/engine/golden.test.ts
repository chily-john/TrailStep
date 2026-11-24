import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../../repo/root.js";
import { manifest } from "../manifest.js";
import { buildGraph } from "./build-graph.js";
import { summarizeGraph } from "./summarize.js";

const REPO_ROOT = findRepoRoot();
const CORE_TSCONFIG = join(REPO_ROOT, "packages", "core", "tsconfig.json");

/**
 * Parent Appendix A (re-measured 2026-11-17 on the same tree): 171 files, 860
 * edges (472 value / 388 type), 0 unresolved. The tolerances are the story's;
 * landing outside them is a stop-and-report, never a calibrated threshold.
 *
 * Divergence from the parent probe, documented deliberately: the probe did not
 * visit `import("…").T` / `typeof import("…")`, which are type-only module
 * references. Story 104's engine classifies them as `type` edges, and each
 * specifier occurrence is an edge, so the tree yields four more: the same file
 * already imports `run-continuation.js` (value, line 23) and
 * `run-workflow.types.js` (`import type`, line 10) and now repeats those two
 * module references three times via `import("…")`, plus one previously
 * invisible pair (`run-continuation/step-attempt.ts` → `workflow-invocation.ts`).
 * Hence +4 edges / +4 type, measured exactly below and still inside the story
 * tolerance windows.
 */
const GOLDEN = {
  files: { expected: 171, delta: 5 },
  edges: { expected: 860, delta: 15 },
  valueEdges: { expected: 472, delta: 10 },
  typeEdges: { expected: 388, delta: 10 },
} as const;

/** Re-measured with `ImportTypeNode` collection on the same tree. */
const MEASURED = {
  files: 171,
  edges: 864,
  valueEdges: 472,
  typeEdges: 392,
} as const;

function expectWithin(
  actual: number,
  target: { expected: number; delta: number },
  label: string,
): void {
  expect(
    actual,
    `${label}: ${actual} is outside ${target.expected}±${target.delta}`,
  ).toBeGreaterThanOrEqual(target.expected - target.delta);
  expect(
    actual,
    `${label}: ${actual} is outside ${target.expected}±${target.delta}`,
  ).toBeLessThanOrEqual(target.expected + target.delta);
}

describe("golden graph for the real tree", () => {
  it("reproduces Appendix A and serializes byte-for-byte identically across builds", () => {
    const first = buildGraph({
      projectRoot: REPO_ROOT,
      tsconfig: CORE_TSCONFIG,
      manifest,
    });
    const second = buildGraph({
      projectRoot: REPO_ROOT,
      tsconfig: CORE_TSCONFIG,
      manifest,
    });

    expectWithin(first.stats.files, GOLDEN.files, "files");
    expectWithin(first.stats.edges, GOLDEN.edges, "edges");
    expectWithin(first.stats.valueEdges, GOLDEN.valueEdges, "value edges");
    expectWithin(first.stats.typeEdges, GOLDEN.typeEdges, "type edges");
    expect(first.stats.resolutionErrors).toBe(0);

    // Exact, per the fix round: the four collected `ImportTypeNode` references
    // must be counted (not merely inside tolerance), and nothing else moved.
    expect({
      files: first.stats.files,
      edges: first.stats.edges,
      valueEdges: first.stats.valueEdges,
      typeEdges: first.stats.typeEdges,
    }).toEqual(MEASURED);

    const firstJson = JSON.stringify(summarizeGraph(first), null, 2);
    const secondJson = JSON.stringify(summarizeGraph(second), null, 2);
    expect(secondJson).toBe(firstJson);

    // Every edge has a source file, so the per-group totals plus the ungrouped
    // root bucket must account for all of them.
    const summary = summarizeGraph(first);
    const groupedEdges = summary.groups.reduce(
      (total, group) => total + group.valueEdgesOut + group.typeEdgesOut,
      0,
    );
    expect(groupedEdges + summary.ungroupedValueEdgesOut + summary.ungroupedTypeEdgesOut).toBe(
      summary.edges,
    );

    console.log(
      `golden core/src: files=${first.stats.files} edges=${first.stats.edges} ` +
        `value=${first.stats.valueEdges} type=${first.stats.typeEdges} ` +
        `unresolved=${first.stats.resolutionErrors}`,
    );
  }, 30_000);

  it("builds the full core/src graph in under two seconds", () => {
    const startedAt = performance.now();
    const graph = buildGraph({
      projectRoot: REPO_ROOT,
      tsconfig: CORE_TSCONFIG,
      manifest,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(graph.stats.files).toBeGreaterThan(0);
    console.log(
      `core/src graph wall time: ${elapsedMs.toFixed(0)} ms ` +
        `(${graph.stats.files} files, ${graph.stats.edges} edges)`,
    );
    expect(elapsedMs).toBeLessThan(2_000);
  }, 30_000);
});
