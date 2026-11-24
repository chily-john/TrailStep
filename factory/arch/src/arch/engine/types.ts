/**
 * Graph shapes for the architecture engine.
 *
 * The engine is product code: every repository-specific value (folder roots,
 * group names, ranks, declared families) arrives through the `EngineManifest`
 * parameter. Nothing in this directory may embed a project path, package name,
 * or folder name — `portability.test.ts` enforces that.
 *
 * The engine is deliberately rule-free. It exposes the file/edge/group graph
 * that the rule layer consumes; it never decides whether an edge is legal.
 */

/** Whether an edge is needed at runtime or only by the type checker (G-2a). */
export type EdgeKind = "value" | "type";

/**
 * The manifest fields the engine needs. The concrete `ArchManifest` satisfies
 * this structurally, and a fixture supplies a minimal object with the same
 * shape — so fixtures never have to build the full production manifest.
 */
export interface EngineRankGroup {
  readonly name: string;
  /** Project-root-relative, `/`-separated (the manifest's convention). */
  readonly root: string;
  /** The normative group this folder becomes; several folders may share one. */
  readonly targetGroup: string;
}

export interface EngineRank {
  readonly rank: number;
  /** The normative group order inside this rank; flattened across ranks it is G2's layer list. */
  readonly docGroups: readonly string[];
  readonly groups: readonly EngineRankGroup[];
}

export interface EngineUnrankedGroup {
  readonly name: string;
  readonly root: string;
  readonly targetGroup: string;
  readonly allowedImportRanks: readonly number[];
}

export interface EngineManifest {
  readonly ranks: readonly EngineRank[];
  readonly unrankedGroups: readonly EngineUnrankedGroup[];
}

/** One group as the graph exposes it, with its rank and layer position. */
export interface GraphGroup {
  readonly name: string;
  readonly root: string;
  /** The owning rank, or `null` for a group the manifest leaves unranked. */
  readonly rank: number | null;
  /** Index in the flattened `docGroups` order, or `null` for an unranked group. */
  readonly layerIndex: number | null;
  readonly targetGroup: string;
}

/** One analyzed source file and its group membership. */
export interface GraphFile {
  /** Project-root-relative, always `/`-separated so serialized output is stable. */
  readonly path: string;
  /** The group whose root contains this file, or `null` for the ungrouped root bucket. */
  readonly group: string | null;
  readonly rank: number | null;
  readonly layerIndex: number | null;
  readonly targetGroup: string | null;
}

/** One import/export specifier resolved to another file in the analyzed set. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
  readonly kind: EdgeKind;
  readonly line: number;
  readonly column: number;
  readonly fromGroup: string | null;
  readonly toGroup: string | null;
}

/**
 * A specifier that could not be resolved. Node builtins and modules outside the
 * analyzed set are not errors; a missing relative path or an undeclared package
 * is, and it is surfaced here rather than silently dropped.
 */
export interface ResolutionError {
  readonly from: string;
  readonly specifier: string;
  readonly kind: EdgeKind;
  readonly line: number;
  readonly column: number;
  readonly reason: string;
}

export interface GraphStats {
  readonly files: number;
  readonly edges: number;
  readonly valueEdges: number;
  readonly typeEdges: number;
  readonly resolutionErrors: number;
}

/** The complete graph the rule layer consumes. */
export interface ArchGraph {
  /** Absolute project root; every `path` above is relative to it. */
  readonly projectRoot: string;
  readonly files: readonly GraphFile[];
  readonly edges: readonly GraphEdge[];
  readonly groups: readonly GraphGroup[];
  readonly resolutionErrors: readonly ResolutionError[];
  readonly stats: GraphStats;
}

/** Inputs to a real-tree graph build. */
export interface BuildGraphOptions {
  /** Absolute project root; manifest group roots resolve against it. */
  readonly projectRoot: string;
  /** Absolute path to the tsconfig that supplies files and compiler options. */
  readonly tsconfig: string;
  readonly manifest: EngineManifest;
  /** Default `false`: the architecture graph counts production files only. */
  readonly includeTests?: boolean;
}
