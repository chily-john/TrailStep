import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildFixtureGraph } from "./arch/engine/index.js";
import { manifest } from "./arch/manifest.js";
import { FIXTURE_MANIFEST, RULE_FIXTURES } from "./arch/rules/fixtures.test.support.js";
import { buildScorecard, runRules } from "./arch/rules/index.js";
import { renderSkill, SKILL_ARTIFACT_PATH } from "./arch/skill.js";
import { type CliDeps, type CliIo, isEntrypoint, runCli } from "./cli.js";
import type { GitResult, GitRunner } from "./cli-changed.js";
import type { ArchReport } from "./cli-report.js";

const BASE_TREE = {
  "src/json/json.ts": "export const json = 1;\n",
  "src/contracts/contracts.ts": "export const contracts = 1;\n",
  "src/contracts/owner/owner.ts": "export const owner = 1;\n",
  "src/contracts/owner/private.ts": "export const privateValue = 1;\n",
  "src/authoring/authoring.ts": "export const authoring = 1;\n",
  "src/authoring/consumer.ts":
    'import { owner } from "../contracts/owner/owner.js";\nexport const consumer = owner;\n',
} as const;

const REACH_IN_TREE = {
  ...BASE_TREE,
  "src/authoring/consumer.ts":
    'import { privateValue } from "../contracts/owner/private.js";\nexport const consumer = privateValue;\n',
} as const;

const MISSING_IMPORT_TREE = {
  ...BASE_TREE,
  "src/authoring/broken.ts":
    'import { missing } from "./does-not-exist.js";\nexport const broken = missing;\n',
} as const;

/** 13 direct files + one subfolder put `src/runtime` over the G5 gate (12). */
const RUNTIME_DEBT_FILES: Record<string, string> = {};
for (let index = 1; index <= 13; index += 1) {
  RUNTIME_DEBT_FILES[`src/runtime/a${index}.ts`] = `export const a${index} = ${index};\n`;
}

/**
 * A deliberately red tree: `src/runtime` is over the G5 gate, `src/runtime/
 * clean` has V-6 debt, and `src/json`/`src/contracts` form a G1 group cycle.
 * The clean files used by the probes live inside that debt and must not block.
 */
const DEBT_TREE = {
  ...RUNTIME_DEBT_FILES,
  "src/runtime/clean/harmless.ts": "export const harmless = 1;\n",
  "src/json/json.ts":
    'import { contracts } from "../contracts/contracts.js";\nexport const json = contracts;\n',
  "src/json/clean-file.ts": "export const cleanFile = 1;\n",
  "src/contracts/contracts.ts":
    'import { json } from "../json/json.js";\nexport const contracts = json;\n',
  "src/contracts/owner/owner.ts": "export const owner = 1;\n",
  "src/contracts/owner/private.ts": "export const privateValue = 1;\n",
  "src/authoring/authoring.ts": "export const authoring = 1;\n",
} as const;

const DEBT_REACH_IN_TREE = {
  ...DEBT_TREE,
  "src/authoring/consumer.ts":
    'import { privateValue } from "../contracts/owner/private.js";\nexport const consumer = privateValue;\n',
} as const;

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
});

interface Harness {
  readonly report: ArchReport;
  readonly repoRoot: string;
  readonly deps: (options: { git?: GitRunner; repoRoot?: string }) => CliDeps;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function harness(files: Readonly<Record<string, string>>): Harness {
  const fixture = buildFixtureGraph({ files }, FIXTURE_MANIFEST);
  cleanup.push(fixture.cleanup);
  const diagnostics = runRules(fixture.graph, FIXTURE_MANIFEST);
  const report: ArchReport = {
    graph: fixture.graph,
    diagnostics,
    scorecard: buildScorecard(fixture.graph, FIXTURE_MANIFEST, diagnostics),
  };
  let out = "";
  let err = "";
  const io: CliIo = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    cwd: fixture.projectRoot,
  };
  return {
    report,
    repoRoot: fixture.projectRoot,
    deps: (options) => ({
      io,
      repoRoot: options.repoRoot ?? fixture.projectRoot,
      git: options.git,
      report: () => report,
    }),
    stdout: () => out,
    stderr: () => err,
  };
}

function gitResult(stdout: string, ok = true): GitResult {
  return { ok, stdout, stderr: "" };
}

function fakeGit(handler: (command: string) => GitResult): GitRunner {
  return (args) => handler(args.join(" "));
}

function dirtyGit(touched: readonly string[]): GitRunner {
  const status = touched.map((file) => ` M ${file}\0`).join("");
  const diff = touched.map((file) => `M\0${file}\0`).join("");
  return fakeGit((command) => {
    if (command === "status --porcelain=v1 -z --untracked-files=normal") {
      return gitResult(status);
    }
    if (command === "diff --name-status -z HEAD --") {
      return gitResult(diff);
    }
    if (command === "ls-files --others --exclude-standard -z") {
      return gitResult("");
    }
    return gitResult(`unexpected: ${command}`, false);
  });
}

function cleanGit(): GitRunner {
  return fakeGit((command) => {
    if (command === "status --porcelain=v1 -z --untracked-files=normal") {
      return gitResult("");
    }
    if (command === "diff --name-status -z HEAD --") {
      return gitResult("");
    }
    return gitResult("", false);
  });
}

function explicitBaseGit(touched: readonly string[]): GitRunner {
  const diff = touched.map((file) => `M\0${file}\0`).join("");
  return fakeGit((command) => {
    if (command === "status --porcelain=v1 -z --untracked-files=normal") {
      return gitResult("");
    }
    if (command === "rev-parse --verify --quiet origin/main^{commit}") {
      return gitResult("base-sha\n");
    }
    if (command === "merge-base HEAD origin/main") {
      return gitResult("abcdef1234567890\n");
    }
    if (command === "diff --name-status -z abcdef1234567890...HEAD --") {
      return gitResult(diff);
    }
    return gitResult(`unexpected: ${command}`, false);
  });
}

describe("architecture CLI", () => {
  it("prints help and exits 0", () => {
    const test = harness(BASE_TREE);
    expect(runCli(["--help"], test.deps({}))).toBe(0);
    expect(test.stdout()).toContain("trailstep architecture gate");
    expect(test.stderr()).toBe("");
  });

  it("check mode exits 0 on a clean tree and writes the scorecard", () => {
    const test = harness(BASE_TREE);
    const out = `${test.repoRoot}/check-scorecard.json`;

    expect(runCli(["--check", "--out", out], test.deps({}))).toBe(0);
    expect(test.stdout()).toContain("Mode: check (blocking; exit 1 on a strict violation)");
    expect(test.stdout()).toContain("Total strict violations: 0");
    expect(test.stdout()).toContain("Verdict: no strict violations — clean.");
    expect(readFileSync(out, "utf8")).toContain('"schemaVersion": 1');
  });

  it("check mode exits 1 on a red tree and prints the full diagnostics", () => {
    const test = harness(REACH_IN_TREE);
    const out = `${test.repoRoot}/check-scorecard.json`;

    expect(runCli(["--check", "--out", out], test.deps({}))).toBe(1);
    expect(test.stdout()).toContain("Mode: check (blocking; exit 1 on a strict violation)");
    expect(test.stdout()).toContain("Total strict violations: 1");
    expect(test.stdout()).toContain("G8  src/authoring/consumer.ts:1");
    expect(test.stdout()).toContain("Verdict: 1 strict violation(s) — blocking.");
    expect(readFileSync(out, "utf8")).toContain('"schemaVersion": 1');
  });

  it("check --json emits a valid scorecard-plus-diagnostics object", () => {
    const test = harness(REACH_IN_TREE);
    const out = `${test.repoRoot}/check-scorecard.json`;

    expect(runCli(["--check", "--json", "--out", out], test.deps({}))).toBe(1);
    const parsed = JSON.parse(test.stdout()) as {
      scorecard: { schemaVersion: number };
      diagnostics: { rule: string; file: string; set: string }[];
    };
    expect(parsed.scorecard.schemaVersion).toBe(1);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      rule: "G8",
      file: "src/authoring/consumer.ts",
      set: "hard",
    });
  });

  it("check --sarif emits the same full diagnostics as SARIF", () => {
    const test = harness(REACH_IN_TREE);
    const out = `${test.repoRoot}/check-scorecard.json`;

    expect(runCli(["--check", "--sarif", "--out", out], test.deps({}))).toBe(1);
    const parsed = JSON.parse(test.stdout()) as {
      runs: { tool: { driver: { name: string } }; results: { ruleId: string; level: string }[] }[];
    };
    expect(parsed.runs[0]?.tool.driver.name).toBe("trailstep-arch");
    expect(parsed.runs[0]?.results).toEqual([
      expect.objectContaining({ ruleId: "G8", level: "error" }),
    ]);
  });

  it("check mode exits 2 on an operational error", () => {
    const test = harness(BASE_TREE);
    const deps: CliDeps = {
      ...test.deps({}),
      report: () => {
        throw new Error("graph build failed");
      },
    };

    expect(runCli(["--check"], deps)).toBe(2);
    expect(test.stderr()).toContain("arch:check: graph build failed");
  });

  it("rejects --check combined with any other mode", () => {
    const test = harness(BASE_TREE);
    expect(runCli(["--check", "--report"], test.deps({}))).toBe(2);
    expect(test.stderr()).toContain("mutually exclusive");
    expect(runCli(["--check", "--changed"], test.deps({}))).toBe(2);
    expect(test.stderr()).toContain("mutually exclusive");
    expect(runCli(["--check", "--explain", "G8"], test.deps({}))).toBe(2);
    expect(test.stderr()).toContain("cannot be combined");
    expect(runCli(["--check", "--emit-skill", "x.md"], test.deps({}))).toBe(2);
    expect(test.stderr()).toContain("cannot be combined");
  });

  it("report mode prints the scorecard and always exits 0, even when red", () => {
    const test = harness(REACH_IN_TREE);
    const out = `${test.repoRoot}/scorecard.json`;
    expect(runCli(["--report", "--out", out], test.deps({}))).toBe(0);
    expect(test.stdout()).toContain("Architecture scorecard — full tree");
    expect(test.stdout()).toContain("Total strict violations: 1");
  });

  it("report --json emits the Story 105 scorecard", () => {
    const test = harness(BASE_TREE);
    const out = `${test.repoRoot}/scorecard.json`;
    expect(runCli(["--report", "--json", "--out", out], test.deps({}))).toBe(0);
    const parsed = JSON.parse(test.stdout()) as {
      schemaVersion: number;
      rules: Record<string, unknown>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(Object.hasOwn(parsed.rules, "G8")).toBe(true);
  });

  it("report --sarif emits a SARIF driver", () => {
    const test = harness(REACH_IN_TREE);
    const out = `${test.repoRoot}/scorecard.json`;
    expect(runCli(["--report", "--sarif", "--out", out], test.deps({}))).toBe(0);
    const parsed = JSON.parse(test.stdout()) as {
      runs: { tool: { driver: { name: string } }; results: { ruleId: string; level: string }[] }[];
    };
    expect(parsed.runs[0]?.tool.driver.name).toBe("trailstep-arch");
    expect(parsed.runs[0]?.results[0]).toMatchObject({ ruleId: "G8", level: "error" });
  });

  it("changed mode exits 0 and says so for a touched clean file", () => {
    const test = harness(BASE_TREE);
    const code = runCli(["--changed"], test.deps({ git: dirtyGit(["src/authoring/consumer.ts"]) }));
    expect(code).toBe(0);
    expect(test.stdout()).toContain("base: HEAD (dirty working tree)");
    expect(test.stdout()).toContain("No strict violations in touched files.");
    expect(test.stdout()).not.toContain("G8  ");
  });

  it("changed mode exits 1 with exactly the G8 diagnostic contract for a reach-in", () => {
    const test = harness(REACH_IN_TREE);
    const code = runCli(["--changed"], test.deps({ git: dirtyGit(["src/authoring/consumer.ts"]) }));
    expect(code).toBe(1);
    const output = test.stdout();
    expect(output).toContain("G8  src/authoring/consumer.ts:1");
    expect(output).toContain("Target: src/contracts/owner/private.ts");
    expect(output).toContain("Rule: G8 (G8 | Reach-ins)");
    expect(output).toContain("Set: hard (blocking)");
    expect(output).toContain(`Fix: ${FIXTURE_MANIFEST.rules.G8.fix}`);
  });

  it("changed mode fails closed on a touched unresolved import with a human diagnostic", () => {
    const test = harness(MISSING_IMPORT_TREE);
    const code = runCli(["--changed"], test.deps({ git: dirtyGit(["src/authoring/broken.ts"]) }));
    expect(code).toBe(1);
    const output = test.stdout();
    expect(output).toContain("ARCH-RESOLVE  src/authoring/broken.ts:1");
    expect(output).toContain('module "./does-not-exist.js" did not resolve (value import)');
    expect(output).toContain("Target: ./does-not-exist.js");
    expect(output).toContain("Fix: Correct the import path");
    expect(output).toContain("operational finding, not a manifest rule");
    expect(output).not.toContain("No strict violations in touched files.");
  });

  it("changed mode emits an unresolved import as an operational JSON finding", () => {
    const test = harness(MISSING_IMPORT_TREE);
    const code = runCli(
      ["--changed", "--json"],
      test.deps({ git: dirtyGit(["src/authoring/broken.ts"]) }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(test.stdout()) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      kind: "operational",
      code: "ARCH-RESOLVE",
      severity: "error",
      file: "src/authoring/broken.ts",
      line: 1,
      target: "./does-not-exist.js",
      set: "error",
    });
    expect(parsed[0]?.message).toContain("did not resolve");
    expect(parsed[0]?.fix).toContain("Correct the import path");
  });

  it("changed mode emits an unresolved import as a blocking SARIF result", () => {
    const test = harness(MISSING_IMPORT_TREE);
    const code = runCli(
      ["--changed", "--sarif"],
      test.deps({ git: dirtyGit(["src/authoring/broken.ts"]) }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(test.stdout()) as {
      runs: {
        tool: { driver: { rules: { id: string; properties?: { kind?: string } }[] } };
        results: { ruleId: string; ruleIndex: number; level: string; message: { text: string } }[];
      }[];
    };
    expect(parsed.runs[0]?.tool.driver.rules).toEqual([
      expect.objectContaining({ id: "ARCH-RESOLVE", properties: { kind: "operational" } }),
    ]);
    expect(parsed.runs[0]?.results).toEqual([
      expect.objectContaining({ ruleId: "ARCH-RESOLVE", ruleIndex: 0, level: "error" }),
    ]);
    expect(parsed.runs[0]?.results[0]?.message.text).toContain("Fix: Correct the import path");
  });

  it("changed mode ignores an unresolved import outside the touched set", () => {
    const test = harness(MISSING_IMPORT_TREE);
    const code = runCli(
      ["--changed", "--json"],
      test.deps({ git: dirtyGit(["src/authoring/consumer.ts"]) }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(test.stdout())).toEqual([]);
  });

  it("report --sarif includes unresolved imports but stays report-only", () => {
    const test = harness(MISSING_IMPORT_TREE);
    const out = `${test.repoRoot}/scorecard.json`;
    expect(runCli(["--report", "--sarif", "--out", out], test.deps({}))).toBe(0);
    const parsed = JSON.parse(test.stdout()) as {
      runs: { results: { ruleId: string; level: string }[] }[];
    };
    expect(parsed.runs[0]?.results).toEqual([
      expect.objectContaining({ ruleId: "ARCH-RESOLVE", level: "error" }),
    ]);
  });

  it("changed mode surfaces G1 when the touched file's own edge is on the cycle", () => {
    const test = harness(RULE_FIXTURES.G1.fail.files);
    const code = runCli(["--changed"], test.deps({ git: dirtyGit(["src/json/json.ts"]) }));
    expect(code).toBe(1);
    expect(test.stdout()).toContain("G1  ");
    expect(test.stdout()).toContain("folder cycle");
  });

  it("changed mode exits 0 for a clean file in a V-6 folder under a G5-red ancestor", () => {
    const test = harness(DEBT_TREE);
    expect(
      test.report.diagnostics.some(
        (diagnostic) => diagnostic.rule === "G5" && diagnostic.file === "src/runtime",
      ),
    ).toBe(true);
    expect(
      test.report.diagnostics.some(
        (diagnostic) => diagnostic.rule === "V-6" && diagnostic.file === "src/runtime/clean",
      ),
    ).toBe(true);

    const code = runCli(
      ["--changed"],
      test.deps({ git: dirtyGit(["src/runtime/clean/harmless.ts"]) }),
    );
    expect(code).toBe(0);
    expect(test.stdout()).toContain("No strict violations in touched files.");
    expect(test.stdout()).not.toContain("G5  ");
    expect(test.stdout()).not.toContain("V-6  ");
  });

  it("changed mode does not block G1 for a file that only lives in a cyclic group", () => {
    const test = harness(DEBT_TREE);
    expect(test.report.diagnostics.some((diagnostic) => diagnostic.rule === "G1")).toBe(true);

    const code = runCli(["--changed"], test.deps({ git: dirtyGit(["src/json/clean-file.ts"]) }));
    expect(code).toBe(0);
    expect(test.stdout()).toContain("No strict violations in touched files.");
    expect(test.stdout()).not.toContain("G1  ");
  });

  it("changed mode blocks exactly one G8 for a reach-in in a debt-carrying tree", () => {
    const test = harness(DEBT_REACH_IN_TREE);
    const code = runCli(
      ["--changed", "--json"],
      test.deps({ git: dirtyGit(["src/authoring/consumer.ts"]) }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(test.stdout()) as {
      rule: string;
      file: string;
      line: number;
      target: string;
      message: string;
      fix: string;
      set: string;
    }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      rule: "G8",
      file: "src/authoring/consumer.ts",
      line: 1,
      target: "src/contracts/owner/private.ts",
      fix: FIXTURE_MANIFEST.rules.G8.fix,
      set: "hard",
    });
    expect(parsed[0]?.message).toContain("import the front door owner.ts");
  });

  it("changed mode excludes deleted and non-source paths from the touched set", () => {
    const test = harness(DEBT_TREE);
    const git = fakeGit((command) => {
      if (command === "status --porcelain=v1 -z --untracked-files=normal") {
        return gitResult(" M src/runtime/clean/harmless.ts\0D  src/json/json.ts\0?? README.md\0");
      }
      if (command === "diff --name-status -z HEAD --") {
        return gitResult("M\0src/runtime/clean/harmless.ts\0D\0src/json/json.ts\0");
      }
      if (command === "ls-files --others --exclude-standard -z") {
        return gitResult("README.md\0");
      }
      return gitResult(`unexpected: ${command}`, false);
    });

    const code = runCli(["--changed"], test.deps({ git }));
    expect(code).toBe(0);
    expect(test.stdout()).toContain(
      "touched source files: 1 (deleted excluded: 1; non-source excluded: 1)",
    );
    expect(test.stdout()).toContain("No strict violations in touched files.");
  });

  it("changed mode is silent when zero files are touched", () => {
    const test = harness(BASE_TREE);
    expect(runCli(["--changed"], test.deps({ git: cleanGit() }))).toBe(0);
    expect(test.stdout()).toBe("");
    expect(test.stderr()).toBe("");
  });

  it("changed mode honors an explicit --base and prints the resolved base", () => {
    const test = harness(REACH_IN_TREE);
    const code = runCli(
      ["--changed", "--base", "origin/main"],
      test.deps({ git: explicitBaseGit(["src/authoring/consumer.ts"]) }),
    );
    expect(code).toBe(1);
    expect(test.stdout()).toContain("base: merge-base HEAD origin/main (abcdef123456)");
    expect(test.stdout()).toContain("G8  src/authoring/consumer.ts:1");
  });

  it("changed mode fails closed when an explicit --base cannot be resolved", () => {
    const test = harness(BASE_TREE);
    const git = fakeGit((command) => {
      if (command === "status --porcelain=v1 -z --untracked-files=normal") {
        return gitResult("");
      }
      return gitResult("", false);
    });

    expect(runCli(["--changed", "--base", "origin/main"], test.deps({ git }))).toBe(2);
    expect(test.stdout()).toBe("");
    expect(test.stderr()).toContain("does not resolve to a commit");
    expect(test.stderr()).toContain("refusing a HEAD-only diff");
  });

  it("changed --json emits the scoped diagnostics", () => {
    const test = harness(REACH_IN_TREE);
    const code = runCli(
      ["--changed", "--json"],
      test.deps({ git: dirtyGit(["src/authoring/consumer.ts"]) }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(test.stdout()) as { rule: string; file: string; fix: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      rule: "G8",
      file: "src/authoring/consumer.ts",
      fix: FIXTURE_MANIFEST.rules.G8.fix,
    });
  });

  it("changed --sarif emits a blocking result", () => {
    const test = harness(REACH_IN_TREE);
    const code = runCli(
      ["--changed", "--sarif"],
      test.deps({ git: dirtyGit(["src/authoring/consumer.ts"]) }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(test.stdout()) as {
      runs: { results: { ruleId: string; level: string }[] }[];
    };
    expect(parsed.runs[0]?.results).toEqual([
      expect.objectContaining({ ruleId: "G8", level: "error" }),
    ]);
  });

  it("explains a known rule and rejects an unknown one with the known list", () => {
    const test = harness(BASE_TREE);
    expect(runCli(["--explain", "G8"], test.deps({}))).toBe(0);
    expect(test.stdout()).toContain("G8 — G8 | Reach-ins");
    expect(test.stdout()).toContain("Good (fixture tree, no G8 diagnostic):");

    expect(runCli(["--explain", "BADID"], test.deps({}))).toBe(1);
    expect(test.stderr()).toContain('unknown rule "BADID"');
    expect(test.stderr()).toContain("G1, G2, G3");
  });

  it("emits the generated skill from the manifest without building the graph", () => {
    const test = harness(BASE_TREE);
    const target = "nested/emitted-skill.md";
    const code = runCli(["--emit-skill", target], test.deps({}));
    expect(code).toBe(0);
    expect(test.stderr()).toBe("");
    expect(test.stdout()).toContain("arch:skill: wrote nested/emitted-skill.md");
    expect(readFileSync(`${test.repoRoot}/${target}`, "utf8")).toBe(renderSkill(manifest));
  });

  it("tags the sanctioned artifact path and keeps --emit-skill out of the other modes", () => {
    const test = harness(BASE_TREE);
    expect(runCli(["--emit-skill", SKILL_ARTIFACT_PATH], test.deps({}))).toBe(0);
    expect(test.stdout()).toContain(`wrote ${SKILL_ARTIFACT_PATH} (the sanctioned artifact)`);

    expect(runCli(["--emit-skill", "x.md", "--json"], test.deps({}))).toBe(2);
    expect(test.stderr()).toContain("not valid with --emit-skill");
    expect(runCli(["--changed", "--emit-skill", "x.md"], test.deps({}))).toBe(2);
    expect(test.stderr()).toContain("cannot be combined");
  });

  it("exits 2 for a usage error and shows the help", () => {
    const test = harness(BASE_TREE);
    expect(runCli(["--report", "--changed"], test.deps({}))).toBe(2);
    expect(test.stderr()).toContain("mutually exclusive");
    expect(test.stderr()).toContain("Usage:");
  });

  it("canonicalizes the entrypoint and fails closed on an unreadable path", () => {
    const self = fileURLToPath(import.meta.url);
    expect(isEntrypoint(import.meta.url, self)).toBe(true);
    expect(isEntrypoint(import.meta.url, `${self}.missing`)).toBe(false);
    expect(isEntrypoint(import.meta.url, undefined)).toBe(false);
  });

  it("runs as the entrypoint when invoked through a symlink", () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const require = createRequire(import.meta.url);
    const typescriptRoot = path.dirname(require.resolve("typescript"));
    const tscPath = path.resolve(typescriptRoot, "..", "bin", "tsc");
    const build = spawnSync(process.execPath, [tscPath, "-p", "tsconfig.json"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(`tsc build failed:\n${build.stderr || build.stdout}`);
    }

    const cliPath = path.join(packageRoot, "dist", "cli.js");
    const linkDirectory = mkdtempSync(path.join(tmpdir(), "arch-cli-symlink-"));
    cleanup.push(() => rmSync(linkDirectory, { recursive: true, force: true }));
    const linkPath = path.join(linkDirectory, "arch-cli.js");
    symlinkSync(cliPath, linkPath);

    const result = spawnSync(process.execPath, [linkPath, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("trailstep architecture gate");
    expect(result.stderr).toBe("");
  }, 30_000);
});
