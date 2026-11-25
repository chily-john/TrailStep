import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFixtureGraph } from "./arch/engine/index.js";
import { FIXTURE_MANIFEST } from "./arch/rules/fixtures.test.support.js";
import { buildScorecard, runRules } from "./arch/rules/index.js";
import { renderReport, writeScorecard } from "./cli-report.js";

const CLEAN_TREE = {
  "src/json/json.ts": "export const json = 1;\n",
  "src/contracts/contracts.ts": "export const contracts = 1;\n",
  "src/contracts/owner/owner.ts": "export const owner = 1;\n",
  "src/contracts/owner/private.ts": "export const privateValue = 1;\n",
  "src/authoring/authoring.ts": "export const authoring = 1;\n",
  "src/authoring/consumer.ts":
    'import { owner } from "../contracts/owner/owner.js";\nexport const consumer = owner;\n',
} as const;

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
});

function cleanReport() {
  const fixture = buildFixtureGraph({ files: CLEAN_TREE }, FIXTURE_MANIFEST);
  cleanup.push(fixture.cleanup);
  const diagnostics = runRules(fixture.graph, FIXTURE_MANIFEST);
  return {
    graph: fixture.graph,
    diagnostics,
    scorecard: buildScorecard(fixture.graph, FIXTURE_MANIFEST, diagnostics),
  };
}

describe("report mode", () => {
  it("renders every rule and the measured totals", () => {
    const report = cleanReport();
    const text = renderReport(report, ".trailstep/arch/architecture-scorecard.json");

    expect(text).toContain("Architecture scorecard — full tree");
    expect(text).toContain("Mode: report (never blocks; exit 0)");
    expect(text).toContain("Files: 6 (6 production, 0 test)");
    expect(text).toContain("Resolution errors: 0");
    expect(text).toContain("  G8   strict    0 violations /   0 files");
    expect(text).toContain("Total strict violations: 0");
    expect(text).toContain("Scorecard: .trailstep/arch/architecture-scorecard.json");
  });

  it("labels the blocking check mode without changing the measurements", () => {
    const report = cleanReport();
    const text = renderReport(report, "scorecard.json", { blocking: true });

    expect(text).toContain("Mode: check (blocking; exit 1 on a strict violation)");
    expect(text).toContain("Total strict violations: 0");
    expect(text).toContain("SCC: groups value");
    expect(text).toContain("SCC: owner folders value");
  });

  it("writes the Story 105 scorecard JSON to the requested path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "arch-report-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const report = cleanReport();
    const target = path.join(directory, "nested", "architecture-scorecard.json");

    writeScorecard(report.scorecard, target);

    const written = JSON.parse(readFileSync(target, "utf8")) as { schemaVersion: number };
    expect(written.schemaVersion).toBe(1);
    expect(written).toEqual(report.scorecard);
  });
});
