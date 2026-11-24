import { describe, expect, it } from "vitest";
import { buildFixtureGraph } from "../engine/fixture-harness.js";
import { manifest } from "../manifest.js";
import { FIXTURE_MANIFEST, RULE_FIXTURES, runRuleOnFixture } from "./fixtures.test.support.js";
import { g3CrossGroupMetric } from "./rule-g3.js";
import {
  BIOME_OWNED_RULE_IDS,
  isStrictRuleId,
  METRIC_RULE_IDS,
  REVIEW_RULE_IDS,
  STRICT_RULE_IMPLEMENTATIONS,
} from "./run-rules.js";

/**
 * The coverage map is explicit: every manifest rule must be one of
 *   - strict: an implementation and a pass/fail fixture pair;
 *   - metric: a graph metric with its own metric test (G3);
 *   - Biome-owned: a manifest pointer, never a duplicate (G6);
 *   - review: documented as unimplemented (M-2, M-7, S-3).
 * Deleting a rule, its implementation, or its fixture fails this file loudly.
 */
describe("rule coverage map", () => {
  it("classifies every manifest rule exactly once", () => {
    const classified = new Set<string>([
      ...Object.keys(STRICT_RULE_IMPLEMENTATIONS),
      ...METRIC_RULE_IDS,
      ...BIOME_OWNED_RULE_IDS,
      ...REVIEW_RULE_IDS,
    ]);
    expect([...classified].sort()).toEqual([...manifest.ruleOrder].sort());
  });

  it("gives every strict rule an implementation and both fixtures", () => {
    for (const ruleId of manifest.ruleOrder) {
      if (manifest.rules[ruleId].severity !== "strict") {
        continue;
      }
      expect(isStrictRuleId(ruleId), `${ruleId} implementation`).toBe(true);
      if (!isStrictRuleId(ruleId)) {
        continue;
      }
      const fixture = RULE_FIXTURES[ruleId];
      expect(fixture, `${ruleId} fixture pair`).toBeDefined();
      expect(runRuleOnFixture(ruleId, fixture.pass), `${ruleId} must-pass`).toEqual([]);
      expect(runRuleOnFixture(ruleId, fixture.fail).length, `${ruleId} must-fail`).toBeGreaterThan(
        0,
      );
    }
  });

  it("keeps G3 as a metric: no implementation, no violation list", () => {
    expect(manifest.rules.G3.severity).toBe("report");
    expect(METRIC_RULE_IDS).toContain("G3");
    expect(isStrictRuleId("G3")).toBe(false);

    const fixture = buildFixtureGraph(
      {
        files: {
          "src/json/json.ts": "export const json = 1;\n",
          "src/contracts/contracts.ts":
            'import { json } from "../json/json.js";\nexport const contracts = json;\n',
          "src/authoring/authoring.ts":
            'import { contracts } from "../contracts/contracts.js";\nexport const a = contracts;\n',
        },
      },
      FIXTURE_MANIFEST,
    );
    try {
      const metric = g3CrossGroupMetric(fixture.graph, FIXTURE_MANIFEST);
      expect(metric).toEqual({
        edges: 2,
        pairs: 2,
        downwardPairs: 2,
        upwardPairs: 0,
        sidewaysPairs: 0,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps G6 a manifest pointer to its Biome owner", () => {
    expect(manifest.rules.G6.severity).toBe("report");
    expect(manifest.rules.G6.owner).toBe("biome");
    expect(BIOME_OWNED_RULE_IDS).toContain("G6");
    expect(isStrictRuleId("G6")).toBe(false);
    expect(Object.hasOwn(RULE_FIXTURES, "G6")).toBe(false);
  });

  it("documents the review set as not implemented", () => {
    for (const ruleId of REVIEW_RULE_IDS) {
      expect(manifest.rules[ruleId].severity).toBe("review");
      expect(isStrictRuleId(ruleId)).toBe(false);
      expect(Object.hasOwn(RULE_FIXTURES, ruleId)).toBe(false);
    }
  });

  it("has no implementation outside the manifest's strict set", () => {
    for (const ruleId of Object.keys(STRICT_RULE_IMPLEMENTATIONS)) {
      expect(manifest.rules[ruleId as keyof typeof manifest.rules].severity).toBe("strict");
    }
  });
});
