import { describe, expect, it } from "vitest";
import { manifest } from "./arch/manifest.js";
import { RULE_FIXTURES, runRuleOnFixture } from "./arch/rules/fixtures.test.support.js";
import { type ExplainExample, isKnownRule, knownRuleIds, renderExplain } from "./cli-explain.js";

function g8Example(): ExplainExample {
  const fixture = RULE_FIXTURES.G8;
  return {
    passFiles: Object.keys(fixture.pass.files).sort(),
    failFiles: Object.keys(fixture.fail.files).sort(),
    diagnostic: runRuleOnFixture("G8", fixture.fail)[0] ?? null,
  };
}

describe("arch:explain", () => {
  it("renders the manifest summary, anchor, fix, legal targets, and fixture example", () => {
    const text = renderExplain(manifest, "G8", g8Example());

    expect(text).toContain("G8 — G8 | Reach-ins");
    expect(text).toContain("Severity: strict");
    expect(text).toContain(`Doc: ${manifest.docUri}#G8 | Reach-ins`);
    expect(text).toContain(`Fix: ${manifest.rules.G8.fix}`);
    expect(text).toContain("Legal targets:");
    expect(text).toContain("Type-only front door: <owner>/<owner>.types.ts");
    expect(text).toContain("Declared type-only families:");
    expect(text).toContain("Good (fixture tree, no G8 diagnostic):");
    expect(text).toContain("Bad (fixture tree, G8 diagnostic):");
    expect(text).toContain("G8  src/authoring/consumer.ts:1");
    expect(text).toContain("Target: src/contracts/owner/private.ts");
  });

  it("marks review-only and metric rules as having no checker implementation", () => {
    const text = renderExplain(manifest, "M-2", null);
    expect(text).toContain("Severity: review");
    expect(text).toContain("none — this rule has no checker implementation");
  });

  it("knows exactly the manifest rule IDs and rejects unknown IDs", () => {
    expect(isKnownRule(manifest, "G8")).toBe(true);
    expect(isKnownRule(manifest, "BADID")).toBe(false);
    expect(knownRuleIds(manifest)).toEqual(manifest.ruleOrder);
    expect(knownRuleIds(manifest)).toContain("T-2");
    expect(knownRuleIds(manifest)).not.toContain("G7");
  });
});
