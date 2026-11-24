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

/** Group names that exist as `packages/core/src/<name>` on the current tree. */
export type CurrentGroupName =
  | "agent-execution"
  | "agent-targeting"
  | "authoring"
  | "cli-provider-runtime"
  | "contracts"
  | "deprecations"
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
  /** Owner folders whose front door is `<folder>.types.ts` (V-6). */
  readonly typeOnlyFamilies: readonly string[];
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
      // `contracts` may import `json`, never the reverse. The order is the rule.
      docGroups: ["json", "contracts"],
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
        "Layer order is the flattened `docGroups` (parent §13.2): rank 0 is `json, contracts`, so `json → contracts` is upward and `contracts → json` is the only legal rank-0 direction.",
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
