import { buildGraph } from "../engine/build-graph.js";
import type { ArchGraph, BuildGraphOptions } from "../engine/types.js";

/**
 * Builds the graph the rule layer expects. Test files must be present for
 * T-1/T-2 (and for G5's measured width, which counts them); the G rules filter
 * them out themselves. The CLI (Story 106) should use this entry point so a
 * production-only graph cannot silently disable the test rules.
 */
export function buildRuleGraph(options: BuildGraphOptions): ArchGraph {
  return buildGraph({ ...options, includeTests: true });
}
