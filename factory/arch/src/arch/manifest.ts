/**
 * The architecture checker's single data file.
 *
 * The engine (Story 104+) is product code: it must contain zero repository
 * strings. Everything project-specific — ranks and their folder roots, rule
 * severities, doc anchors, one-line fix recipes, budgets, exemptions, declared
 * type-only families, and the demotion log — lives here.
 *
 * Normative source: `viking://resources/trailstep/docs/architecture/codebase-architecture.md`
 * (§2.2 scorecard, §8.1 ranks, §10 tests, and the rule sections), as amended by
 * Story 102 (`rule-amendments-strict.md`).
 *
 * Current-tree note (parent work order §13.2): W1 records the CURRENT group
 * names and folder roots; W6 renames a group and moves its root in the same
 * commit as the folder move. `docGroups` and `targetGroup` keep the §8.1
 * normative names visible, so the W6 edit is a rename rather than a redesign.
 * `evidence` is not a top-level group today — it still lives inside `runtime`
 * and becomes its own rank-3 group during W6.
 */

/** How a rule is enforced. `review` rules have no checker implementation. */
export type RuleSeverity = "strict" | "report" | "review";

/**
 * Every rule the checker owns, exactly once. `G7` is deliberately absent:
 * knip owns dead exports (parent §7.1). G6 is present only to carry its
 * Biome-owner pointer and the 600-line budget into `arch:explain`.
 */
export type RuleId =
  | "G1"
  | "G2"
  | "G3"
  | "G4"
  | "G5"
  | "G6"
  | "G8"
  | "S-3"
  | "S-5"
  | "S-6"
  | "S-9"
  | "V-4"
  | "V-6"
  | "N-1"
  | "M-2"
  | "M-6"
  | "M-7"
  | "T-1"
  | "T-2";

/** The four numbered ranks in amended §8.1. A typo is a compile error. */
export type RankLevel = 0 | 1 | 2 | 3;

/**
 * Group names the manifest vocabulary accepts. All but `evidence` exist as
 * `packages/core/src/<name>` on the current tree; `evidence` becomes a
 * top-level rank-3 group in W6 (it still lives inside `runtime` today) and is
 * needed by fixtures to exercise the `execution ↮ evidence` exclusion.
 */
export type CurrentGroupName =
  | "agent-execution"
  | "agent-targeting"
  | "authoring"
  | "cli-provider-runtime"
  | "contracts"
  | "deprecations"
  | "evidence"
  | "json"
  | "mcp"
  | "providers"
  | "runs"
  | "runtime";

/** The normative group names declared by amended §8.1. */
export type TargetGroupName =
  | "authoring"
  | "contracts"
  | "deprecations"
  | "evidence"
  | "execution"
  | "json"
  | "providers"
  | "run-store";

/** One rule's severity, doc anchor, and one-line fix recipe. */
export interface RuleSpec {
  readonly severity: RuleSeverity;
  /** A heading or rule ID as it appears verbatim in the amended architecture doc. */
  readonly anchor: string;
  /** One line, imperative: what the author does to fix a violation. */
  readonly fix: string;
  /** Set when a different tool owns the rule; the checker only reports it. */
  readonly owner?: "biome";
  /** Extra context for `arch:explain`; never rule prose. */
  readonly notes?: string;
}

/** A group folder and the §8.1 group it becomes after W6. */
export interface RankGroup {
  readonly name: CurrentGroupName;
  /** Repo-relative path, always `/`-separated (manifest rule). */
  readonly root: string;
  readonly targetGroup: TargetGroupName;
}

/**
 * Two §8.1 groups in the same rank that may not import each other, in EITHER
 * direction. The pair is unordered: `{ from: "execution", to: "evidence" }`
 * forbids `execution → evidence` and `evidence → execution` alike.
 *
 * This is manifest data, not a G2 special case: §8.1 gives rank 2
 * (`providers`, `run-store`) "May import 0–1" and rank 3 (`execution`,
 * `evidence`) "May import 0–2", and calls out `execution ↮ evidence` —
 * "never, in either direction" / "the write path never imports the read path".
 * Rank 0 is deliberately NOT a forbidden pair: `contracts → json` is legal and
 * `json → contracts` is forbidden by the layer order alone.
 */
export interface ForbiddenPeerPair {
  readonly from: TargetGroupName;
  readonly to: TargetGroupName;
}

export interface RankLayer {
  /** The §8.1 rank band (0–3). G2's layer index comes from `docGroups`, not this. */
  readonly rank: RankLevel;
  /**
   * The §8.1 groups occupying this rank (the W6 target names), in layer order.
   * Concatenated across ranks this is the G2 layer list (parent §13.2): every
   * import must point to a group that appears earlier in it. Rank 0 is
   * `json, contracts`, so the one-way edge needs no peer-import exception.
   */
  readonly docGroups: readonly TargetGroupName[];
  /**
   * Same-rank target groups closed to each other in both directions (§8.1).
   * Every entry must name two distinct `docGroups` of this rank; an empty list
   * is correct for a rank with one group (rank 1) or a sanctioned peer edge
   * (rank 0).
   */
  readonly forbiddenPeers: readonly ForbiddenPeerPair[];
  /** Current folders mapped to their target groups; order mirrors `docGroups`. */
  readonly groups: readonly RankGroup[];
}

/**
 * A group §8.1 leaves unranked: it is a leaf that may only import the listed
 * ranks. Today that is `deprecations` (may import rank 0, imported by nobody).
 */
export interface UnrankedGroup {
  readonly name: CurrentGroupName;
  readonly root: string;
  readonly targetGroup: TargetGroupName;
  readonly allowedImportRanks: readonly RankLevel[];
}

export interface Exemption {
  readonly rule: RuleId;
  /** Repo-relative path that MUST resolve on disk; never a known violation. */
  readonly path: string;
  readonly reason: string;
}

/**
 * Data the rule layer would otherwise have to hard-code: role folder names
 * (`internal`, `api`), the test convention, folder-shape budgets, and the
 * label for the package-root bucket in the scorecard.
 *
 * These are repo conventions, not repo paths: the manifest is the one place a
 * project name may appear. Rule and engine sources stay free of either.
 */
export interface ArchConventions {
  /** The layer folder whose files may not read the public surface (S-6) or ambient env (M-6). */
  readonly internalFolder: string;
  /** The package's public-surface folder; not an owner folder for G8/V-6. */
  readonly publicSurfaceFolder: string;
  /** Cross-cutting tests live in `<package>/<this>/` (T-2). */
  readonly crossCuttingTestFolder: string;
  readonly testSuffix: string;
  /** The declared type-only family front-door suffix (V-6/G8). */
  readonly typeOnlySuffix: string;
  /**
   * The schema-file suffix (`<stem>.schema.ts`). T-1/T-2 resolve it as a unit
   * kind: a test colocated with an owner's schema is a unit test (doc T-1).
   */
  readonly schemaSuffix: string;
  /** Folder names whose subtrees are fixtures, not production shapes. */
  readonly fixtureFolderNames: readonly string[];
  /** Folder names that name a technical role instead of a capability (S-5). */
  readonly bannedFolderNames: readonly string[];
  /** Basenames banned below the package root (N-1). */
  readonly reservedFilenames: readonly string[];
  /** V-4: this many same-prefix files in one folder means a folder is missing. */
  readonly repeatedPrefixThreshold: number;
  /** G4 scorecard metric: folder depth below the package root, pre-exemption. */
  readonly ncaCandidateDepth: number;
  /** G4 scorecard metric: the label for files directly at the package root. */
  readonly packageRootBucket: string;
}

/** A strict → report move recorded by the demotion protocol. */
export interface DemotionRecord {
  readonly rule: RuleId;
  readonly from: "strict";
  readonly to: "report";
  /** Measured false-positive diagnostics behind the move. */
  readonly noiseCount: number;
  readonly reason: string;
  /** The visible, reviewed commit that made the move. */
  readonly reviewedCommit: string;
}

export interface ArchManifest {
  readonly ranks: readonly RankLayer[];
  readonly unrankedGroups: readonly UnrankedGroup[];
  /**
   * MATERIALIZED type-only families: the owner folder exists and its
   * `<folder>.types.ts` front door already exists (validated). V-6 accepts the
   * door and G8 treats it as the only legal import target.
   *
   * W6 OBLIGATION: every `contractFamilyRoots` folder moves here in the SAME
   * commit that creates its `<folder>.types.ts` door and rewrites its imports.
   * The two lists are disjoint (validated), so a folder has exactly one family
   * declaration — there is no duplicate family list.
   */
  readonly typeOnlyFamilies: readonly string[];
  /**
   * PENDING contract-family folders whose TARGET front door is
   * `<folder>.types.ts` (amended §13.2 file map and Appendix D: `shapes`,
   * `events`, `process`, `agents`), but whose door does not exist yet. V-6 names
   * that target door (red by design); G8 accepts it as the expected name so a
   * post-W6 import of the sanctioned door is not a reach-in.
   *
   * `evidence` is NOT here: its target door is `evidence.ts` (a runtime value),
   * like `json.ts` and `failures.ts`. A `contracts/agents` caveat is recorded
   * at the entry itself.
   */
  readonly contractFamilyRoots: readonly string[];
  /** The normative document every diagnostic cites (rendered/JSON `doc`). */
  readonly docUri: string;
  /**
   * The folder/file vocabulary the rule layer needs (Story 105). Rules carry
   * no repository strings; every name, suffix, and threshold below is data.
   * The engine does not consume this block; the rule layer does.
   */
  readonly conventions: ArchConventions;
  readonly rules: Readonly<Record<RuleId, RuleSpec>>;
  /** The rule table's own enumeration: ordering for explain/skill generation. */
  readonly ruleOrder: readonly RuleId[];
  readonly budgets: {
    readonly folderWidth: { readonly target: number; readonly gate: number };
    readonly fileLines: {
      readonly limit: number;
      /** Biome owns this budget; the checker records it for `arch:explain` only. */
      readonly owner: "biome";
      readonly biomeRule: string;
    };
  };
  readonly exemptions: readonly Exemption[];
  readonly demotionProtocol: {
    /** Minimum false-positive diagnostics before a demotion is admissible. */
    readonly minimumNoiseCount: number;
    readonly requiresReviewedCommit: true;
    readonly requiresScorecardTelemetry: true;
  };
  readonly demotions: readonly DemotionRecord[];
}

/**
 * The manifest.
 *
 * G2's layer order is the flattened `docGroups` across ranks (parent §13.2's
 * `layers` list): every import must point to a group earlier in that list.
 * Rank 0 is ordered `json, contracts`, so `contracts → json` is downward and
 * `json → contracts` is upward — the one-way rule is owned by the order, with
 * no peer-import exception. Folders that share a `targetGroup` share a layer.
 *
 * Severity sets (rev 4 decision 1): strict = G1, G2, G4, G5, G8, S-5, S-6,
 * S-9, V-4, V-6, N-1, M-6, T-1, T-2; report = G3, G6; review = M-2, M-7, S-3.
 * G7 is absent (knip owns it).
 */
export const manifest = deepFreeze({
  ranks: [
    {
      rank: 0,
      // Parent §13.2's `layers` list starts `["json", "contracts", ...]`:
      // `contracts` may import `json`, never the reverse. The order is the rule,
      // so rank 0 is the sanctioned peer edge and declares no forbidden pair.
      docGroups: ["json", "contracts"],
      forbiddenPeers: [],
      groups: [
        {
          name: "json",
          root: "packages/core/src/json",
          targetGroup: "json",
        },
        {
          name: "contracts",
          root: "packages/core/src/contracts",
          targetGroup: "contracts",
        },
      ],
    },
    {
      rank: 1,
      docGroups: ["authoring"],
      forbiddenPeers: [],
      groups: [
        {
          name: "authoring",
          root: "packages/core/src/authoring",
          targetGroup: "authoring",
        },
      ],
    },
    {
      rank: 2,
      docGroups: ["providers", "run-store"],
      // §8.1: rank 2 "May import 0–1" — the two groups of the band are closed
      // to each other. `run-store → providers` is ordered downward by
      // `docGroups`, so the layer list alone would let it pass; this pair is
      // what makes the band exclusion real.
      forbiddenPeers: [{ from: "providers", to: "run-store" }],
      // Until W6: providers/{targeting,cli-runtime,mcp-config} are the
      // agent-targeting, cli-provider-runtime and mcp folders; run-store is `runs`.
      groups: [
        {
          name: "providers",
          root: "packages/core/src/providers",
          targetGroup: "providers",
        },
        {
          name: "agent-targeting",
          root: "packages/core/src/agent-targeting",
          targetGroup: "providers",
        },
        {
          name: "cli-provider-runtime",
          root: "packages/core/src/cli-provider-runtime",
          targetGroup: "providers",
        },
        {
          name: "mcp",
          root: "packages/core/src/mcp",
          targetGroup: "providers",
        },
        {
          name: "runs",
          root: "packages/core/src/runs",
          targetGroup: "run-store",
        },
      ],
    },
    {
      rank: 3,
      docGroups: ["execution", "evidence"],
      // §8.1: rank 3 "May import 0–2" and `execution ↮ evidence` — "never, in
      // either direction" ("the write path never imports the read path").
      // `execution → evidence` is caught by the layer order; the reverse edge is
      // ordered downward, so the pair is the load-bearing half.
      forbiddenPeers: [{ from: "execution", to: "evidence" }],
      // Until W6: `runtime` is the pre-split catch-all (most of it becomes
      // execution); `agent-execution` is the dispatch half of execution.
      groups: [
        {
          name: "runtime",
          root: "packages/core/src/runtime",
          targetGroup: "execution",
        },
        {
          name: "agent-execution",
          root: "packages/core/src/agent-execution",
          targetGroup: "execution",
        },
      ],
    },
  ],

  // §8.1: `deprecations` has no rank; it is a leaf policy artifact that may
  // import rank 0 and is imported by nobody.
  unrankedGroups: [
    {
      name: "deprecations",
      root: "packages/core/src/deprecations",
      targetGroup: "deprecations",
      allowedImportRanks: [0],
    },
  ],

  // Owner folders whose public front door is `<folder>.types.ts` (V-6/N-2).
  // Single-file pure-type families; the front-door filename is derived from the
  // folder name, never listed here (parent §13.2). `dispatch-provenance` is not
  // a member: it exports the runtime const DISPATCH_PROVENANCE_SCHEMA_VERSION,
  // and V-6 names a runtime-value family's front door `<folder>.ts`.
  typeOnlyFamilies: ["packages/core/src/contracts/run-context"],

  // The doc's TARGET `.types.ts` front doors that W6 has not created yet
  // (amended §13.2 file map + Appendix D). V-6 names these (red by design);
  // G8 already treats `<folder>.types.ts` as the expected door, so post-W6
  // imports are not reach-ins. `run-context` is in `typeOnlyFamilies`, not here
  // (disjoint lists — one declaration per family).
  //
  // `agents` CAVEAT (W6 must resolve it before declaring the family):
  // `contracts/agents/agent-execution.types.ts` exports a runtime const
  // (`DEFAULT_AGENT_EXECUTION`) and two functions, so today the family is NOT
  // type-only. V-6: "a family that exports runtime values names it
  // `<folder>.ts`", while amended §13.2/Appendix D name `agents.types.ts`.
  // W6 MUST move those runtime exports out of the family (to their execution
  // owner) so `agents.types.ts` is genuinely types-only, then declare the family
  // in `typeOnlyFamilies` in the same commit as the door.
  contractFamilyRoots: [
    "packages/core/src/contracts/agents",
    "packages/core/src/contracts/events",
    "packages/core/src/contracts/process",
    "packages/core/src/contracts/shapes",
  ],

  docUri: "viking://resources/trailstep/docs/architecture/codebase-architecture.md",

  // Story 105's rule vocabulary. These are the only place role folder names
  // and shape thresholds are written down; rule sources read them as data.
  conventions: {
    internalFolder: "internal",
    publicSurfaceFolder: "api",
    crossCuttingTestFolder: "test",
    testSuffix: ".test.ts",
    typeOnlySuffix: ".types.ts",
    schemaSuffix: ".schema.ts",
    fixtureFolderNames: ["fixtures", "__fixtures__"],
    bannedFolderNames: ["utils", "helpers", "common", "misc", "lib"],
    reservedFilenames: ["types.ts", "helpers.ts", "constants.ts", "utils.ts", "index.ts"],
    repeatedPrefixThreshold: 3,
    ncaCandidateDepth: 2,
    packageRootBucket: "(root)",
  },

  ruleOrder: [
    "G1",
    "G2",
    "G3",
    "G4",
    "G5",
    "G6",
    "G8",
    "S-3",
    "S-5",
    "S-6",
    "S-9",
    "V-4",
    "V-6",
    "N-1",
    "M-2",
    "M-6",
    "M-7",
    "T-1",
    "T-2",
  ],

  rules: {
    G1: {
      severity: "strict",
      anchor: "G1 | Group cycles",
      fix: "Break the cycle: move the shared shape to the lower-ranked group or remove the edge that closes the loop.",
    },
    G2: {
      severity: "strict",
      anchor: "G2 | Upward imports",
      fix: "Remove the upward edge; if a lower rank needs the shape, it belongs at rank 0 (`json` or `contracts`).",
      notes:
        "Layer order is the flattened `docGroups` (parent §13.2): rank 0 is `json, contracts`, so `json → contracts` is upward and `contracts → json` is the only legal rank-0 direction. Each rank's `forbiddenPeers` also closes the band: rank 2 `providers`/`run-store` and rank 3 `execution`/`evidence` may not import each other in either direction (§8.1).",
    },
    G3: {
      severity: "report",
      anchor: "G3 | Cross-group imports",
      fix: "Keep every cross-group edge pointing downward; the report is a trend, not a pass/fail list.",
    },
    G4: {
      severity: "strict",
      anchor: "G4 | NCA violations",
      fix: "Move the private helper up to the parent group or expose it through the parent's front door.",
    },
    G5: {
      severity: "strict",
      anchor: "G5 | Max folder width",
      fix: "Split the folder by flow until it has at most 8 direct children (the migration gate is 12).",
    },
    G6: {
      severity: "report",
      anchor: "G6 | Max file size",
      fix: "Split the file; Biome owns the 600-line cap (tests and fixtures are exempt).",
      owner: "biome",
      notes:
        "Recorded for `arch:explain` only. Biome `style/noExcessiveLinesPerFile` enforces 600 lines; the checker does not duplicate it.",
    },
    G8: {
      severity: "strict",
      anchor: "G8 | Reach-ins",
      fix: "Import the owner's front door (`<owner>.ts`, or `<owner>.types.ts` for a declared type-only family), not a private sibling.",
    },
    "S-3": {
      severity: "review",
      anchor: "files are either pure type re-exports or thin wrappers over an",
      fix: "Keep `api/` to pure type re-exports or thin wrappers; move logic and module state into the owning internal front door.",
    },
    "S-5": {
      severity: "strict",
      anchor: "Every direct child of `internal/` names a capability",
      fix: "Rename the folder for its capability, adapter, dependency layer, or store; `utils`/`helpers`/`common`/`misc`/`lib` are banned.",
    },
    "S-6": {
      severity: "strict",
      anchor: "Nothing under `internal/` may import from `api/`",
      fix: "Move the shared shape into `internal/`; `api/` may import `internal/`, never the reverse.",
    },
    "S-9": {
      severity: "strict",
      anchor: "A folder with exactly one child that is itself a folder, and no files, is a",
      fix: "Fold the single-child folder up unless its name carries a real distinction.",
    },
    "V-4": {
      severity: "strict",
      anchor: "Repeated filename prefixes are a missing folder.",
      fix: "Create the missing folder and move the three same-prefix files into it.",
    },
    "V-6": {
      severity: "strict",
      anchor: "Every module-like folder has one obvious front door",
      fix: "Add `<folder>/<folder>.ts` (or a declared `<folder>.types.ts`) as the folder's front door.",
    },
    "N-1": {
      severity: "strict",
      anchor: "kebab-case files.",
      fix: "Rename the file to kebab-case and replace `types.ts`/`helpers.ts`/`constants.ts`/`utils.ts`/`index.ts` with an owner-named front door.",
    },
    "M-2": {
      severity: "review",
      anchor: "A boolean parameter in a public signature is a defect.",
      fix: "Replace the boolean parameter with two front doors or a discriminated union the module decides.",
    },
    "M-6": {
      severity: "strict",
      anchor: "Externals are parameters, never ambient",
      fix: "Pass the filesystem, clock, cwd, env, spawn, exit, or stdio in as a parameter instead of reading it ambiently.",
    },
    "M-7": {
      severity: "review",
      anchor: "No mutable module-level singletons under `internal/`",
      fix: "Pass the registry, store, or context in; remove the mutable module-level singleton.",
    },
    "T-1": {
      severity: "strict",
      anchor: "Unit tests are colocated",
      fix: "Move the test beside its unit as `foo.test.ts`, or move a cross-cutting test to `packages/<pkg>/test/` per T-2.",
    },
    "T-2": {
      severity: "strict",
      anchor: "Cross-cutting tests (CLI subprocess, MCP transport, end-to-end runs) live in",
      fix: "Move CLI/MCP/end-to-end tests to `packages/<pkg>/test/`; there is no third location.",
    },
  },

  budgets: {
    folderWidth: { target: 8, gate: 12 },
    fileLines: {
      limit: 600,
      owner: "biome",
      biomeRule: "style/noExcessiveLinesPerFile",
    },
  },

  // Empty at green. An exemption is a documented semantic exception with a
  // reason, never measured migration debt (that is the demotion protocol), and
  // never a known violation. The dashboard's documented api/internal exception
  // (§3.2 D) is encoded by the rules themselves (`internal/` scoping, core-only
  // ranks), so it needs no path exemption.
  exemptions: [],

  demotionProtocol: {
    // Demotion is the only shaving mechanism (parent rev 4 decision 2). A rule
    // moves strict → report only by a visible, reviewed commit that cites
    // per-rule noise counts from scorecard telemetry. The threshold is
    // deliberately high so one noisy PR cannot demote a rule:
    //   - at least `minimumNoiseCount` measured false-positive diagnostics;
    //   - a one-line reason in the demotion record;
    //   - a reviewed commit hash (never a silent or baseline edit).
    minimumNoiseCount: 10,
    requiresReviewedCommit: true,
    requiresScorecardTelemetry: true,
  },

  // Empty at green. Add a record only by following `demotionProtocol`.
  demotions: [],
} as const satisfies ArchManifest);

/**
 * Recursively freezes a plain data object so a caller cannot mutate the
 * manifest at runtime (the `as const satisfies` contract already makes every
 * field readonly at compile time).
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
