import path from "node:path";
import { describe, expect, it } from "vitest";
import { manifest, type RuleId } from "../manifest.js";
import { diagnosticJson, renderDiagnostic } from "./diagnostics.js";
import { type FixtureCase, RULE_FIXTURES, runRuleOnFixture } from "./fixtures.test.support.js";
import { STRICT_RULE_IMPLEMENTATIONS } from "./run-rules.js";

const STRICT_RULE_IDS = manifest.ruleOrder.filter(
  (ruleId) => manifest.rules[ruleId].severity === "strict",
);

function withoutFile(fixture: FixtureCase, path: string): FixtureCase {
  const files = { ...fixture.files };
  delete files[path];
  return { ...fixture, files };
}

function withFile(fixture: FixtureCase, path: string, source: string): FixtureCase {
  return { ...fixture, files: { ...fixture.files, [path]: source } };
}

describe("strict rule fixtures", () => {
  for (const ruleId of STRICT_RULE_IDS) {
    const fixture = RULE_FIXTURES[ruleId as keyof typeof RULE_FIXTURES];
    const implementation =
      STRICT_RULE_IMPLEMENTATIONS[ruleId as keyof typeof STRICT_RULE_IMPLEMENTATIONS];

    it(`${ruleId}: must-pass fixture produces no diagnostic`, () => {
      expect(fixture).toBeDefined();
      expect(runRuleOnFixture(ruleId as keyof typeof RULE_FIXTURES, fixture.pass)).toEqual([]);
    });

    it(`${ruleId}: must-fail fixture produces its diagnostic`, () => {
      const diagnostics = runRuleOnFixture(ruleId as keyof typeof RULE_FIXTURES, fixture.fail);

      expect(diagnostics.length).toBeGreaterThan(0);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.rule).toBe(ruleId);
        expect(diagnostic.severity).toBe("strict");
        expect(diagnostic.set).toBe("hard");
        expect(diagnostic.fix).toBe(manifest.rules[ruleId].fix);
        expect(diagnostic.docAnchor).toBe(manifest.rules[ruleId].anchor);
        expect(diagnostic.file).not.toBe("");
        expect(diagnostic.target).not.toBe("");
        expect(diagnostic.message).not.toBe("");
      }
    });

    it(`${ruleId}: is registered as a rule function (graph + manifest + read context)`, () => {
      expect(typeof implementation).toBe("function");
    });
  }
});

describe("primary violations", () => {
  it("G1 reports the complete SCC membership at the group roots", () => {
    const diagnostics = runRuleOnFixture("G1", RULE_FIXTURES.G1.fail);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      file: "src/contracts",
      target: "contracts, json",
    });
    expect(diagnostics[0]?.message).toContain("2 groups");
  });

  it("G2 carries the importing file's line and the upward target", () => {
    const [diagnostic] = runRuleOnFixture("G2", RULE_FIXTURES.G2.fail);
    expect(diagnostic).toMatchObject({
      file: "src/json/json.ts",
      line: 1,
      column: 1,
      target: "src/contracts/contracts.ts",
    });
    expect(diagnostic?.message).toContain("layer 0 → 1");
  });

  it("G5 names the measured width against the gate", () => {
    const [diagnostic] = runRuleOnFixture("G5", RULE_FIXTURES.G5.fail);
    expect(diagnostic).toMatchObject({
      file: "src/runtime/wide",
      target: "13 direct children",
    });
  });

  it("G8 points at the private file and names the front door", () => {
    const [diagnostic] = runRuleOnFixture("G8", RULE_FIXTURES.G8.fail);
    expect(diagnostic).toMatchObject({
      file: "src/authoring/consumer.ts",
      target: "src/contracts/owner/private.ts",
    });
    expect(diagnostic?.message).toContain("owner.ts");
  });
});

describe("diagnostic rendering", () => {
  it("renders the §9.1 shape and a stable JSON object", () => {
    const [diagnostic] = runRuleOnFixture("G2", RULE_FIXTURES.G2.fail);
    expect(diagnostic).toBeDefined();
    if (diagnostic === undefined) {
      return;
    }

    const rendered = renderDiagnostic(diagnostic);
    expect(rendered).toContain(`G2  ${diagnostic.file}:${diagnostic.line ?? 0}`);
    expect(rendered).toContain(`Target: ${diagnostic.target}`);
    expect(rendered).toContain("Rule: G2 (");
    expect(rendered).toContain(manifest.docUri);
    expect(rendered).toContain(`Fix: ${manifest.rules.G2.fix}`);
    expect(rendered).toContain("Set: hard (blocking)");

    const json = diagnosticJson(diagnostic);
    expect(Object.keys(json)).toEqual([
      "rule",
      "severity",
      "file",
      "line",
      "column",
      "target",
      "message",
      "fix",
      "doc",
      "anchor",
      "set",
    ]);
    expect(json).toMatchObject({
      rule: "G2",
      severity: "strict",
      file: diagnostic.file,
      line: diagnostic.line,
      column: diagnostic.column,
      target: diagnostic.target,
      fix: manifest.rules.G2.fix,
      doc: manifest.docUri,
      anchor: manifest.rules.G2.anchor,
      set: "hard",
    });
  });
});

describe("mutation tests: removing the cause removes the violation", () => {
  it("G1 disappears when exactly one cycle edge is removed", () => {
    const mutated = withFile(RULE_FIXTURES.G1.fail, "src/json/json.ts", "export const json = 1;\n");
    expect(runRuleOnFixture("G1", RULE_FIXTURES.G1.fail)).not.toHaveLength(0);
    expect(runRuleOnFixture("G1", mutated)).toEqual([]);
  });

  it("G2 disappears when the upward import is removed", () => {
    const mutated = withFile(RULE_FIXTURES.G2.fail, "src/json/json.ts", "export const json = 1;\n");
    expect(runRuleOnFixture("G2", RULE_FIXTURES.G2.fail)).not.toHaveLength(0);
    expect(runRuleOnFixture("G2", mutated)).toEqual([]);
  });

  it("G4 disappears when one sibling importer stops importing", () => {
    const mutated = withFile(
      RULE_FIXTURES.G4.fail,
      "src/runtime/scope/beta/b.ts",
      "export const b = 1;\n",
    );
    expect(runRuleOnFixture("G4", RULE_FIXTURES.G4.fail)).not.toHaveLength(0);
    expect(runRuleOnFixture("G4", mutated)).toEqual([]);
  });

  it("G4 disappears when the extra sibling folder is removed", () => {
    const mutated = withoutFile(RULE_FIXTURES.G4.fail, "src/runtime/scope/beta/b.ts");
    expect(runRuleOnFixture("G4", mutated)).toEqual([]);
  });

  it("G8 disappears when the importer targets the front door", () => {
    const mutated = withFile(
      RULE_FIXTURES.G8.fail,
      "src/authoring/consumer.ts",
      'import { owner } from "../contracts/owner/owner.js";\nexport const consumer = owner;\n',
    );
    expect(runRuleOnFixture("G8", RULE_FIXTURES.G8.fail)).not.toHaveLength(0);
    expect(runRuleOnFixture("G8", mutated)).toEqual([]);
  });
});

describe("G2 rank-band exclusions (§8.1 forbiddenPeers)", () => {
  interface PeerCase {
    readonly name: string;
    readonly importer: string;
    readonly imported: string;
  }

  const PROVIDERS = "src/providers/providers.ts";
  const RUNS = "src/runs/runs.ts";
  const EXECUTION = "src/runtime/runtime.ts";
  const EVIDENCE = "src/evidence/evidence.ts";

  const cases: readonly PeerCase[] = [
    { name: "run-store → providers", importer: RUNS, imported: PROVIDERS },
    { name: "providers → run-store", importer: PROVIDERS, imported: RUNS },
    { name: "execution → evidence", importer: EXECUTION, imported: EVIDENCE },
    { name: "evidence → execution", importer: EVIDENCE, imported: EXECUTION },
  ];

  function importSpecifier(from: string, to: string): string {
    const relative = path.posix.relative(path.posix.dirname(from), to).replace(/\.ts$/u, "");
    return `./${relative}.js`;
  }

  function edgeFiles(importer: string, imported: string): Record<string, string> {
    const specifier = importSpecifier(importer, imported);
    return {
      [imported]: "export const value = 1;\n",
      [importer]: `import { value } from "${specifier}";\nexport const consumer = value;\n`,
    };
  }

  for (const { name, importer, imported } of cases) {
    it(`rejects ${name} in either direction`, () => {
      const diagnostics = runRuleOnFixture("G2", { files: edgeFiles(importer, imported) });

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.file).toBe(importer);
      expect(diagnostics[0]?.message).toContain("may not import each other");
    });

    it(`drops ${name} when the edge is removed`, () => {
      const files = edgeFiles(importer, imported);
      const mutated = { ...files, [importer]: "export const consumer = 1;\n" };

      expect(runRuleOnFixture("G2", { files })).not.toHaveLength(0);
      expect(runRuleOnFixture("G2", { files: mutated })).toEqual([]);
    });
  }

  it("keeps same-target-group imports legal (one §8.1 group, not two peers)", () => {
    // `runtime` and `agent-execution` are both the future `execution` group; an
    // intra-group import is not a peer import.
    const files = edgeFiles("src/agent-execution/agent-execution.ts", "src/runtime/runtime.ts");

    expect(runRuleOnFixture("G2", { files })).toEqual([]);
  });
});

describe("V-4 prefix/folder relation", () => {
  function repeatedPrefixFiles(folder: string, prefix: string): Record<string, string> {
    return {
      [`${folder}/${prefix}-a.ts`]: "export const a = 1;\n",
      [`${folder}/${prefix}-b.ts`]: "export const b = 1;\n",
      [`${folder}/${prefix}-c.ts`]: "export const c = 1;\n",
    };
  }

  it("does not fire when the folder is the prefix", () => {
    expect(
      runRuleOnFixture("V-4", { files: repeatedPrefixFiles("src/runtime/scheduler", "scheduler") }),
    ).toEqual([]);
  });

  it("does not fire when the folder pluralizes the prefix", () => {
    expect(
      runRuleOnFixture("V-4", { files: repeatedPrefixFiles("src/contracts/agents", "agent") }),
    ).toEqual([]);
    expect(
      runRuleOnFixture("V-4", { files: repeatedPrefixFiles("src/providers", "provider") }),
    ).toEqual([]);
  });

  it("does not fire when the folder starts with the prefix", () => {
    expect(
      runRuleOnFixture("V-4", { files: repeatedPrefixFiles("src/runtime/sub-prompts", "sub") }),
    ).toEqual([]);
    expect(
      runRuleOnFixture("V-4", {
        files: repeatedPrefixFiles("src/runtime/continuation/run-continuation", "run"),
      }),
    ).toEqual([]);
  });

  it("fires when the folder is unrelated to the prefix (doc's scheduler case)", () => {
    const diagnostics = runRuleOnFixture("V-4", {
      files: repeatedPrefixFiles("src/runtime/run-workflow", "scheduler"),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.target).toBe("scheduler-*");
    expect(diagnostics[0]?.message).toContain('create "scheduler/"');
  });

  it("still fires for a prefix unrelated to a prefix-carrying folder", () => {
    const diagnostics = runRuleOnFixture("V-4", {
      files: {
        ...repeatedPrefixFiles("src/runtime/run-continuation", "step"),
        "src/runtime/run-continuation/run-continuation.ts": "export const run = 1;\n",
      },
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.target).toBe("step-*");
  });
});

describe("P2-4 contract-family front doors", () => {
  it("V-6 names the pending W6 target door, not <folder>.ts", () => {
    const diagnostics = runRuleOnFixture("V-6", {
      files: { "src/contracts/pending-family/agent-role.types.ts": "export type X = 1;\n" },
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.target).toBe("pending-family.types.ts");
    expect(diagnostics[0]?.message).toContain("W6 target");
  });

  it("V-6 accepts a materialized family's declared door", () => {
    expect(
      runRuleOnFixture("V-6", {
        files: { "src/contracts/typed-family/typed-family.types.ts": "export type Typed = 1;\n" },
      }),
    ).toEqual([]);
  });

  it("G8 expects the pending family's .types.ts door and still rejects a private sibling", () => {
    const files = {
      "src/contracts/pending-family/pending-family.types.ts": "export type Pending = 1;\n",
      "src/contracts/pending-family/pending-private.ts": "export const privateValue = 1;\n",
      "src/authoring/consumer.ts":
        'import { privateValue } from "../contracts/pending-family/pending-private.js";\nexport const consumer = privateValue;\n',
    };

    const diagnostics = runRuleOnFixture("G8", { files });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.target).toBe("src/contracts/pending-family/pending-private.ts");
    expect(diagnostics[0]?.message).toContain("pending-family.types.ts");
  });
});

describe("T-1/T-2 unit kinds and the cross-cutting definition", () => {
  it("T-1/T-2 accept a test colocated with a .types.ts unit", () => {
    const files = {
      "src/contracts/agents/agent-execution.types.ts": "export type Exec = { value: number };\n",
      // A second §8.1 group makes the T-2 span test load-bearing: with
      // `.ts`-only unit resolution this test is cross-cutting and T-2 fires.
      "src/providers/providers.ts": "export const providers = 1;\n",
      "src/contracts/agents/agent-execution.test.ts":
        'import type { Exec } from "./agent-execution.types.js";\n' +
        'import { providers } from "../../providers/providers.js";\n' +
        "export const exec: Exec = { value: providers };\n",
    };

    // Both rules: the unit is resolved, so the test is neither misplaced (T-1)
    // nor cross-cutting (T-2). With `.ts`-only unit resolution T-2 fires here,
    // which is the P2-3 regression this pair pins.
    expect(runRuleOnFixture("T-1", { files, includeTests: true })).toEqual([]);
    expect(runRuleOnFixture("T-2", { files, includeTests: true })).toEqual([]);
  });

  it("T-1/T-2 accept a test colocated with a .schema.ts unit", () => {
    const files = {
      "src/contracts/evidence/evidence.schema.ts": "export type Evidence = { value: number };\n",
      "src/runtime/runtime.ts": "export const runtime = 1;\n",
      "src/contracts/evidence/evidence.test.ts":
        'import type { Evidence } from "./evidence.schema.js";\n' +
        'import { runtime } from "../../runtime/runtime.js";\n' +
        "export const evidence: Evidence = { value: runtime };\n",
    };

    expect(runRuleOnFixture("T-1", { files, includeTests: true })).toEqual([]);
    expect(runRuleOnFixture("T-2", { files, includeTests: true })).toEqual([]);
  });

  it("T-1 reports a test whose .types.ts unit sits in another folder", () => {
    const files = {
      "src/contracts/agents/agent-execution.types.ts": "export type Exec = 1;\n",
      "src/runtime/agent-execution.test.ts":
        'import type { Exec } from "../contracts/agents/agent-execution.types.js";\nexport const exec: Exec = 1;\n',
    };

    const diagnostics = runRuleOnFixture("T-1", { files, includeTests: true });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.target).toBe("src/contracts/agents/agent-execution.types.ts");
  });

  it("T-2 leaves a no-unit test alone when it stays inside one §8.1 group", () => {
    const files = {
      "src/runtime/run-workflow/run-workflow.ts": "export const workflow = 1;\n",
      "src/runtime/run-workflow/run-workflow-continuation.test.ts":
        'import { workflow } from "./run-workflow.js";\nexport const t = workflow;\n',
    };

    expect(runRuleOnFixture("T-2", { files, includeTests: true })).toEqual([]);
  });
  it("T-2 still reports a cross-cutting test with no unit", () => {
    const diagnostics = runRuleOnFixture("T-2", RULE_FIXTURES["T-2"].fail);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("cross-cutting tests belong in");
  });
});

describe("M-6 ambient env forms and the injected read seam", () => {
  const INTERNAL_FILE = "src/runtime/internal/capability/capability.ts";

  it("detects destructuring process.env", () => {
    const diagnostics = runRuleOnFixture("M-6", {
      files: { [INTERNAL_FILE]: "const { env } = process;\nexport const home = env.HOME;\n" },
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.target).toBe("process.env");
    expect(diagnostics[0]?.message).toContain("destructures");
  });

  it("detects a renamed destructuring of process.env", () => {
    const diagnostics = runRuleOnFixture("M-6", {
      files: {
        [INTERNAL_FILE]:
          "const { env: environment } = process;\nexport const home = environment.HOME;\n",
      },
    });

    expect(diagnostics).toHaveLength(1);
  });

  it("detects process.env through an alias", () => {
    const diagnostics = runRuleOnFixture("M-6", {
      files: { [INTERNAL_FILE]: "const p = process;\nexport const home = p.env.HOME;\n" },
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("alias");
  });

  it("detects element access forms", () => {
    const diagnostics = runRuleOnFixture("M-6", {
      files: {
        [INTERNAL_FILE]: 'export const home = process["env"].HOME;\n',
      },
    });

    expect(diagnostics).toHaveLength(1);
  });

  it("reads sources through the injected context, never the filesystem", () => {
    // The fail fixture contains `process.env`, but an empty reader supplies no
    // source text: if M-6 touched `ts.sys.readFile` it would still report.
    expect(runRuleOnFixture("M-6", RULE_FIXTURES["M-6"].fail, { readSource: () => "" })).toEqual(
      [],
    );
    expect(runRuleOnFixture("M-6", RULE_FIXTURES["M-6"].fail)).not.toHaveLength(0);
  });
});

describe("review set stays unimplemented", () => {
  it("does not expose implementations for M-2, M-7, or S-3", () => {
    const reviewRules: RuleId[] = ["M-2", "M-7", "S-3"];
    for (const ruleId of reviewRules) {
      expect(
        Object.hasOwn(STRICT_RULE_IMPLEMENTATIONS, ruleId),
        `${ruleId} must stay review-only`,
      ).toBe(false);
    }
  });
});
