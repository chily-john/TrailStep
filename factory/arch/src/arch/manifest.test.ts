import { describe, expect, expectTypeOf, it } from "vitest";
import { findRepoRoot } from "../repo/root.js";
import { manifest, type RankGroup, type RuleId } from "./manifest.js";
import { assertManifestValid, manifestProblems } from "./manifest-validation.js";

const REPO_ROOT = findRepoRoot();

/** Rev 4 decision 1 — the normative strict set, exactly. */
const STRICT_RULES = [
  "G1",
  "G2",
  "G4",
  "G5",
  "G8",
  "S-5",
  "S-6",
  "S-9",
  "V-4",
  "V-6",
  "N-1",
  "M-6",
  "T-1",
  "T-2",
] as const satisfies readonly RuleId[];

/** G3 is the only always-report rule; G6 is present for its Biome-owner pointer. */
const REPORT_RULES = ["G3", "G6"] as const satisfies readonly RuleId[];

/** Judgment rules stay review-only until their false-positive rate is measured. */
const REVIEW_RULES = ["M-2", "M-7", "S-3"] as const satisfies readonly RuleId[];

function rulesWithSeverity(severity: "strict" | "report" | "review"): RuleId[] {
  return manifest.ruleOrder.filter((ruleId) => manifest.rules[ruleId].severity === severity);
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

describe("the architecture manifest", () => {
  it("validates against the current repository tree", () => {
    expect(manifestProblems(manifest, REPO_ROOT)).toEqual([]);
    expect(() => assertManifestValid(manifest, REPO_ROOT)).not.toThrow();
  });

  it("encodes the §8.1 rank order and the normative group names", () => {
    expect(manifest.ranks.map((layer) => layer.rank)).toEqual([0, 1, 2, 3]);
    expect(manifest.ranks.map((layer) => [...layer.docGroups])).toEqual([
      ["json", "contracts"],
      ["authoring"],
      ["providers", "run-store"],
      ["execution", "evidence"],
    ]);
    expect(sorted(manifest.ranks.flatMap((layer) => layer.docGroups))).toEqual(
      sorted(["authoring", "contracts", "evidence", "execution", "json", "providers", "run-store"]),
    );

    // `deprecations` is unranked: a leaf that may import rank 0 (§8.1).
    expect(manifest.unrankedGroups).toHaveLength(1);
    expect(manifest.unrankedGroups[0].targetGroup).toBe("deprecations");
    expect(manifest.unrankedGroups[0].allowedImportRanks).toEqual([0]);
  });

  it("keeps rank 0 one-way in the ordered layer list", () => {
    const layerOrder: readonly string[] = manifest.ranks.flatMap((layer) => layer.docGroups);
    const rankZero = manifest.ranks[0];

    // Parent §13.2's `layers` list: `json` is the lower layer, so the one-way
    // rule follows from the order with no peer-import exception.
    expect(layerOrder).toEqual([
      "json",
      "contracts",
      "authoring",
      "providers",
      "run-store",
      "execution",
      "evidence",
    ]);
    expect(rankZero.docGroups).toEqual(["json", "contracts"]);
    expect(rankZero.groups.map((group) => group.name)).toEqual(["json", "contracts"]);

    // G2 semantics: an import may only point to a group earlier in the list.
    const layerOf = (group: string): number => layerOrder.indexOf(group);
    const isUpwardImport = (from: string, to: string): boolean => layerOf(to) > layerOf(from);

    expect(isUpwardImport("contracts", "json")).toBe(false);
    expect(isUpwardImport("json", "contracts")).toBe(true);

    // G2 itself carries the layer-order rule for `arch:explain`.
    expect(manifest.rules.G2.notes).toContain("json → contracts");
  });

  it("declares only real current group folders, each named by its root", () => {
    const groups: readonly Pick<RankGroup, "name" | "root" | "targetGroup">[] = [
      ...manifest.ranks.flatMap((layer): readonly RankGroup[] => layer.groups),
      ...manifest.unrankedGroups,
    ];

    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.root.startsWith("packages/core/src/")).toBe(true);
      expect(group.root.endsWith(`/${group.name}`)).toBe(true);
    }

    // `evidence` becomes a rank-3 group in W6; it is not a top-level folder yet.
    expect(manifest.ranks.flatMap((layer) => layer.docGroups)).toContain("evidence");
    expect(
      manifest.ranks.flatMap((layer) => layer.groups.map((group) => group.targetGroup)),
    ).not.toContain("evidence");
  });

  it("declares only genuinely type-only `<folder>.types.ts` families", () => {
    expect(manifest.typeOnlyFamilies).toEqual(["packages/core/src/contracts/run-context"]);

    // `dispatch-provenance` exports the runtime const
    // DISPATCH_PROVENANCE_SCHEMA_VERSION, so V-6 names its front door
    // `<folder>.ts`; declaring it type-only would whitelist the wrong suffix.
    expect(manifest.typeOnlyFamilies).not.toContain(
      "packages/core/src/contracts/dispatch-provenance",
    );
  });

  it("encodes the rev-4 severity sets", () => {
    expect(sorted(rulesWithSeverity("strict"))).toEqual(sorted(STRICT_RULES));
    expect(sorted(rulesWithSeverity("report"))).toEqual(sorted(REPORT_RULES));
    expect(sorted(rulesWithSeverity("review"))).toEqual(sorted(REVIEW_RULES));
    expect(sorted(manifest.ruleOrder)).toEqual(
      sorted([...STRICT_RULES, ...REPORT_RULES, ...REVIEW_RULES]),
    );
  });

  it("has no G7 (knip owns dead exports) and no duplicate rule IDs", () => {
    expect(sorted(manifest.ruleOrder)).not.toContain("G7");
    expect(new Set(manifest.ruleOrder).size).toBe(manifest.ruleOrder.length);
    expectTypeOf<Extract<RuleId, "G7">>().toEqualTypeOf<never>();
    expectTypeOf<keyof typeof manifest.rules>().toEqualTypeOf<RuleId>();
  });

  it("points G6 at its Biome owner instead of duplicating it", () => {
    const g6 = manifest.rules.G6;

    expect(g6.severity).toBe("report");
    expect(g6.owner).toBe("biome");
    expect(g6.notes).toContain("style/noExcessiveLinesPerFile");
    expect(g6.fix).toContain("600");
  });

  it("gives every rule a severity, a doc anchor, and a one-line fix recipe", () => {
    for (const ruleId of manifest.ruleOrder) {
      const rule = manifest.rules[ruleId];

      expect(rule.anchor.trim(), `${ruleId} anchor`).not.toBe("");
      expect(rule.fix.trim(), `${ruleId} fix`).not.toBe("");
      expect(rule.fix.includes("\n"), `${ruleId} fix must be one line`).toBe(false);
    }

    for (const ruleId of STRICT_RULES) {
      expect(manifest.rules[ruleId].severity).toBe("strict");
    }
  });

  it("records the budgets and the Biome-owned file cap", () => {
    expect(manifest.budgets).toEqual({
      folderWidth: { target: 8, gate: 12 },
      fileLines: {
        limit: 600,
        owner: "biome",
        biomeRule: "style/noExcessiveLinesPerFile",
      },
    });
  });

  it("starts with an empty demotion log and the protocol recorded", () => {
    expect(manifest.demotions).toEqual([]);
    expect(manifest.demotionProtocol.minimumNoiseCount).toBeGreaterThanOrEqual(1);
    expect(manifest.demotionProtocol.requiresReviewedCommit).toBe(true);
    expect(manifest.demotionProtocol.requiresScorecardTelemetry).toBe(true);
  });

  it("is frozen at runtime and under a second to validate", () => {
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.ruleOrder)).toBe(true);
    expect(Object.isFrozen(manifest.rules)).toBe(true);
    expect(Object.isFrozen(manifest.ranks)).toBe(true);
    expect(Object.isFrozen(manifest.ranks[0].groups)).toBe(true);
    expect(Object.isFrozen(manifest.budgets.folderWidth)).toBe(true);

    const startedAt = performance.now();
    expect(manifestProblems(manifest, REPO_ROOT)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});
