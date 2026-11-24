/**
 * Public surface of the architecture engine. Rules (Story 105) consume
 * `ArchGraph`; the CLI (Story 106) also uses `buildFixtureGraph` for
 * `arch:explain` examples and `summarizeGraph` for the scorecard.
 */
export { buildGraph } from "./build-graph.js";
export type { FixtureGraph, FixtureTree } from "./fixture-harness.js";
export { buildFixtureGraph } from "./fixture-harness.js";
export type { GraphSummary, GroupSummary } from "./summarize.js";
export { summarizeGraph } from "./summarize.js";
export type {
  ArchGraph,
  BuildGraphOptions,
  EdgeKind,
  EngineManifest,
  GraphEdge,
  GraphFile,
  GraphGroup,
  GraphStats,
  ResolutionError,
} from "./types.js";
