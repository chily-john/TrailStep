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
  it("G1 reports a cross-group cycle once, at the group roots", () => {
    const diagnostics = runRuleOnFixture("G1", RULE_FIXTURES.G1.fail);
    // The same cross-group cycle is a group SCC; it must never be repeated as
    // an owner-folder SCC (owner SCCs are computed per group).
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      file: "src/contracts",
      target: "contracts, json",
      targetKind: "group",
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

describe("G4 private-helper NCA vs deliberate front-door composition", () => {
  const OWNER_FRONT_DOOR = "src/runtime/scope/owner/owner.ts";
  const OWNER_PRIVATE = "src/runtime/scope/owner/private.ts";
  const ALPHA = "src/runtime/scope/alpha/a.ts";
  const BETA = "src/runtime/scope/beta/b.ts";

  it("passes when same-parent siblings compose through the owner's front door", () => {
    const files = {
      [OWNER_FRONT_DOOR]: "export const owner = 1;\n",
      [OWNER_PRIVATE]: "export const privateValue = 1;\n",
      [ALPHA]: 'import { owner } from "../owner/owner.js";\nexport const a = owner;\n',
      [BETA]: 'import { owner } from "../owner/owner.js";\nexport const b = owner;\n',
    };

    expect(runRuleOnFixture("G4", { files })).toEqual([]);
  });

  it("fails when same-parent siblings both reach into the private file", () => {
    const files = {
      [OWNER_FRONT_DOOR]: "export const owner = 1;\n",
      [OWNER_PRIVATE]: "export const privateValue = 1;\n",
      [ALPHA]:
        'import { privateValue } from "../owner/private.js";\nexport const a = privateValue;\n',
      [BETA]:
        'import { privateValue } from "../owner/private.js";\nexport const b = privateValue;\n',
    };

    const diagnostics = runRuleOnFixture("G4", { files });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      file: "src/runtime/scope/owner",
      target: "alpha, beta",
    });
    expect(diagnostics[0]?.message).toContain("non-front-door importers");
    expect(diagnostics[0]?.message).toContain("private helper shared by sibling areas");
  });

  it("ignores the owner's own intra-folder imports (intra-owner is not a reach-in)", () => {
    // The owner imports its own private sibling, and exactly one sibling area
    // reaches in. Only the reach-in can count, so the NCA span is one child.
    const files = {
      "src/runtime/scope/helper/helper.ts":
        'import { helperValue } from "./private.js";\nexport const helper = helperValue;\n',
      "src/runtime/scope/helper/private.ts": "export const helperValue = 1;\n",
      "src/runtime/scope/alpha/a.ts":
        'import { helperValue } from "../helper/private.js";\nexport const a = helperValue;\n',
    };

    expect(runRuleOnFixture("G4", { files })).toEqual([]);
  });

  it("does not count a single private reach-in as an NCA span", () => {
    // One front-door composer plus one private reach-in is a G8 case: only the
    // reach-in bypasses the door, so the NCA children set has one member.
    const files = {
      [OWNER_FRONT_DOOR]: "export const owner = 1;\n",
      [OWNER_PRIVATE]: "export const privateValue = 1;\n",
      [ALPHA]: 'import { owner } from "../owner/owner.js";\nexport const a = owner;\n',
      [BETA]:
        'import { privateValue } from "../owner/private.js";\nexport const b = privateValue;\n',
    };

    expect(runRuleOnFixture("G4", { files })).toEqual([]);
  });

  it("accepts a declared materialized .types.ts front door", () => {
    const files = {
      "src/contracts/typed-family/typed-family.types.ts":
        "export type Typed = { value: number };\n",
      "src/contracts/typed-family/secret.ts": "export const secret = 1;\n",
      "src/contracts/alpha/a.ts":
        'import type { Typed } from "../typed-family/typed-family.types.js";\nexport const a: Typed = { value: 1 };\n',
      "src/contracts/beta/b.ts":
        'import type { Typed } from "../typed-family/typed-family.types.js";\nexport const b: Typed = { value: 2 };\n',
    };

    expect(runRuleOnFixture("G4", { files })).toEqual([]);
  });

  it("accepts a pending family's declared .types.ts front door", () => {
    const files = {
      "src/contracts/pending-family/pending-family.types.ts":
        "export type Pending = { value: number };\n",
      "src/contracts/pending-family/secret.ts": "export const secret = 1;\n",
      "src/contracts/alpha/a.ts":
        'import type { Pending } from "../pending-family/pending-family.types.js";\nexport const a: Pending = { value: 1 };\n',
      "src/contracts/beta/b.ts":
        'import type { Pending } from "../pending-family/pending-family.types.js";\nexport const b: Pending = { value: 2 };\n',
    };

    expect(runRuleOnFixture("G4", { files })).toEqual([]);
  });

  it("does not apply to a top-level group (its parent is the package root)", () => {
    // The deprecations-class false positive: sibling top-level groups reaching
    // into one group are G2/G3/G8 relationships, never a G4 NCA case.
    const files = {
      "src/json/json.ts": "export const json = 1;\n",
      "src/json/private.ts": "export const privateValue = 1;\n",
      "src/contracts/read.ts":
        'import { privateValue } from "../json/private.js";\nexport const contracts = privateValue;\n',
      "src/authoring/read.ts":
        'import { privateValue } from "../json/private.js";\nexport const authoring = privateValue;\n',
    };

    expect(runRuleOnFixture("G4", { files })).toEqual([]);
  });

  it("applies to a rank-0 folder below a group root (no rank-0 exemption)", () => {
    const files = {
      "src/json/scope/helper/helper.ts": "export const helper = 1;\n",
      "src/json/scope/helper/private.ts": "export const privateValue = 1;\n",
      "src/json/scope/alpha/a.ts":
        'import { privateValue } from "../helper/private.js";\nexport const a = privateValue;\n',
      "src/json/scope/beta/b.ts":
        'import { privateValue } from "../helper/private.js";\nexport const b = privateValue;\n',
    };

    const diagnostics = runRuleOnFixture("G4", { files });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      file: "src/json/scope/helper",
      target: "alpha, beta",
    });
  });
});

describe("G1 owner-folder cycles inside one group", () => {
  const AGENTS_FRONT_DOOR = "src/contracts/agents/agents.ts";
  const RUN_CONTEXT_FRONT_DOOR = "src/contracts/run-context/run-context.ts";

  function valueCycleFiles(): Record<string, string> {
    return {
      [AGENTS_FRONT_DOOR]:
        'import { runContext } from "../run-context/run-context.js";\nexport const agents = runContext;\n',
      [RUN_CONTEXT_FRONT_DOOR]:
        'import { agents } from "../agents/agents.js";\nexport const runContext = agents;\n',
    };
  }

  it("reports a same-group value cycle at owner-folder level", () => {
    const diagnostics = runRuleOnFixture("G1", { files: valueCycleFiles() });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      file: "src/contracts/agents",
      target: "src/contracts/agents, src/contracts/run-context",
      targetKind: "owner",
    });
    expect(diagnostics[0]?.message).toContain(
      "owner-folder cycle in group contracts across 2 owner folders",
    );
  });

  it("computes owner cycles independently inside each group", () => {
    const files = {
      ...valueCycleFiles(),
      "src/runtime/alpha/alpha.ts":
        'import { beta } from "../beta/beta.js";\nexport const alpha = beta;\n',
      "src/runtime/beta/beta.ts":
        'import { alpha } from "../alpha/alpha.js";\nexport const beta = alpha;\n',
    };

    const diagnostics = runRuleOnFixture("G1", { files });

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.targetKind)).toEqual(["owner", "owner"]);
    expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
      "src/contracts/agents",
      "src/runtime/alpha",
    ]);
    expect(diagnostics[0]?.message).toContain("group contracts");
    expect(diagnostics[1]?.message).toContain("group runtime");
  });

  it("does not repeat a cross-group cycle as an owner-folder cycle", () => {
    const files = {
      "src/contracts/contracts.ts":
        'import { runtime } from "../runtime/runtime.js";\nexport const contracts = runtime;\n',
      "src/runtime/runtime.ts":
        'import { contracts } from "../contracts/contracts.js";\nexport const runtime = contracts;\n',
    };

    const diagnostics = runRuleOnFixture("G1", { files });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      target: "contracts, runtime",
      targetKind: "group",
    });
  });

  it("counts a same-group type-only cycle", () => {
    const diagnostics = runRuleOnFixture("G1", {
      files: {
        [AGENTS_FRONT_DOOR]:
          'import type { RunContext } from "../run-context/run-context.js";\nexport type Agents = { context: RunContext };\n',
        [RUN_CONTEXT_FRONT_DOOR]:
          'import type { Agents } from "../agents/agents.js";\nexport type RunContext = { agents: Agents };\n',
      },
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("owner-folder cycle");
  });

  it("leaves acyclic front-door composition alone", () => {
    const diagnostics = runRuleOnFixture("G1", {
      files: {
        [AGENTS_FRONT_DOOR]:
          'import { runContext } from "../run-context/run-context.js";\nexport const agents = runContext;\n',
        [RUN_CONTEXT_FRONT_DOOR]: "export const runContext = 1;\n",
      },
    });

    expect(diagnostics).toEqual([]);
  });

  it("excludes test edges and test owners consistently", () => {
    const files = {
      [AGENTS_FRONT_DOOR]: "export const agents = 1;\n",
      [RUN_CONTEXT_FRONT_DOOR]:
        'import { agents } from "../agents/agents.js";\nexport const runContext = agents;\n',
      // The reverse edge exists only in a test: owner cycles are production
      // architecture, exactly like the group SCC view.
      "src/contracts/agents/agents.test.ts":
        'import { runContext } from "../run-context/run-context.js";\nexport const t = runContext;\n',
    };

    expect(runRuleOnFixture("G1", { files, includeTests: true })).toEqual([]);
  });

  it("disappears when exactly one owner-cycle edge is removed", () => {
    const files = valueCycleFiles();
    const mutated = {
      ...files,
      [RUN_CONTEXT_FRONT_DOOR]: "export const runContext = 1;\n",
    };

    expect(runRuleOnFixture("G1", { files })).not.toHaveLength(0);
    expect(runRuleOnFixture("G1", { files: mutated })).toEqual([]);
  });
});

describe("diagnostic rendering", () => {
  it("serializes the structured G1 target kind in the diagnostic payload", () => {
    const [diagnostic] = runRuleOnFixture("G1", RULE_FIXTURES.G1.fail);
    expect(diagnostic).toBeDefined();
    if (diagnostic === undefined) {
      return;
    }

    expect(diagnostic.targetKind).toBe("group");
    expect(diagnosticJson(diagnostic).targetKind).toBe("group");
  });

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
