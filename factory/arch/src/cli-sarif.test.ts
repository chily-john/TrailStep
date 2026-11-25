import { describe, expect, it } from "vitest";
import { manifest } from "./arch/manifest.js";
import { RULE_FIXTURES, runRuleOnFixture } from "./arch/rules/fixtures.test.support.js";
import { createDiagnostic, resolutionErrorDiagnostics } from "./arch/rules/index.js";
import { renderSarif, sarifLevel } from "./cli-sarif.js";

describe("SARIF rendering", () => {
  it("pins the golden shape: one result, rule ID, fix recipe, locations", () => {
    const diagnostics = runRuleOnFixture("G8", RULE_FIXTURES.G8.fail);
    const [diagnostic] = diagnostics;
    expect(diagnostic).toBeDefined();
    if (diagnostic === undefined) {
      return;
    }

    const sarif = JSON.parse(renderSarif(manifest, diagnostics)) as Record<string, unknown>;

    expect(sarif).toEqual({
      // biome-ignore lint/style/useNamingConvention: SARIF requires the "$schema" key.
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "trailstep-arch",
              informationUri: manifest.docUri,
              rules: [
                {
                  id: "G8",
                  name: "G8",
                  shortDescription: { text: manifest.rules.G8.fix },
                  helpUri: `${manifest.docUri}#${encodeURIComponent(manifest.rules.G8.anchor)}`,
                },
              ],
            },
          },
          results: [
            {
              ruleId: "G8",
              ruleIndex: 0,
              level: "error",
              message: { text: `${diagnostic.message} Fix: ${manifest.rules.G8.fix}` },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: {
                      uri: "src/authoring/consumer.ts",
                      uriBaseId: "%SRCROOT%",
                    },
                    region: { startLine: 1, startColumn: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("renders an unresolved import as its own operational SARIF rule", () => {
    const [finding] = resolutionErrorDiagnostics([
      {
        from: "src/authoring/broken.ts",
        specifier: "./missing.js",
        kind: "value",
        line: 3,
        column: 1,
        reason: 'module "./missing.js" did not resolve',
      },
    ]);
    expect(finding).toBeDefined();
    if (finding === undefined) {
      return;
    }

    const sarif = JSON.parse(renderSarif(manifest, [finding])) as {
      runs: {
        tool: { driver: { rules: Record<string, unknown>[] } };
        results: Record<string, unknown>[];
      }[];
    };

    expect(sarif.runs[0]?.tool.driver.rules).toEqual([
      {
        id: "ARCH-RESOLVE",
        name: "ARCH-RESOLVE",
        shortDescription: { text: finding.fix },
        properties: { kind: "operational" },
      },
    ]);
    expect(sarif.runs[0]?.results).toEqual([
      {
        ruleId: "ARCH-RESOLVE",
        ruleIndex: 0,
        level: "error",
        message: { text: `${finding.message} Fix: ${finding.fix}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "src/authoring/broken.ts", uriBaseId: "%SRCROOT%" },
              region: { startLine: 3, startColumn: 1 },
            },
          },
        ],
      },
    ]);
    expect(manifest.ruleOrder as readonly string[]).not.toContain("ARCH-RESOLVE");
  });

  it("maps strict to error and report/review to note", () => {
    expect(sarifLevel("strict")).toBe("error");
    expect(sarifLevel("report")).toBe("note");
    expect(sarifLevel("review")).toBe("note");

    const report = createDiagnostic(manifest, "G3", {
      file: "src/contracts/contracts.ts",
      target: "src/runtime",
      message: "cross-group trend",
    });
    const sarif = JSON.parse(renderSarif(manifest, [report])) as {
      runs: { results: { level: string }[] }[];
    };
    expect(sarif.runs[0]?.results[0]?.level).toBe("note");
  });

  it("renders a valid empty document", () => {
    const sarif = JSON.parse(renderSarif(manifest, [])) as {
      runs: { tool: { driver: { rules: unknown[] } }; results: unknown[] }[];
    };
    expect(sarif.runs[0]?.tool.driver.rules).toEqual([]);
    expect(sarif.runs[0]?.results).toEqual([]);
  });
});
