import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Rev 4 decision 3: the engine is product code with zero repository strings.
 * Every path, package name, rank root, and family reaches it as a parameter.
 *
 * This test scans the *non-test* engine sources for string literals (and regex
 * literals) containing a repository path segment or package name. Test files
 * are exempt because they must name the real tree (the golden test) and must
 * carry deliberate violations (this file). Comments and prose are not literals,
 * so documentation may still explain the rule.
 *
 * The deliberate-violation cases below prove the scanner fails when it should:
 * an in-memory bad source and a temp-directory bad source both produce a
 * violation. Removing this test's own engine scan would leave the guard vacuous.
 */

/** One engine source file to scan. */
interface EngineSource {
  readonly file: string;
  readonly source: string;
}

/** One literal that names a repository path segment or package. */
interface PortabilityViolation {
  readonly file: string;
  readonly literal: string;
  readonly fragment: string;
}

const BANNED_SEGMENTS = new Set([
  "packages",
  "factory",
  "runtime",
  "internal",
  "contracts",
  "authoring",
  "providers",
  "agent-execution",
  "agent-targeting",
  "cli-provider-runtime",
  "deprecations",
  "mcp",
  "runs",
  "scripts",
  "json",
]);

/** The repository and package namespace; any literal containing it is project data. */
const BANNED_FRAGMENTS = ["trailstep"] as const;

const ENGINE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function bannedFragment(literal: string): string | null {
  const lower = literal.toLowerCase();
  const fragment = BANNED_FRAGMENTS.find((candidate) => lower.includes(candidate));

  if (fragment !== undefined) {
    return fragment;
  }

  // Segment-aware: `src/runs/file.ts` names a repo folder even though the whole
  // literal matches nothing. Splitting on both separators keeps Windows-planted
  // strings caught too.
  for (const segment of lower.split(/[\\/]/u)) {
    if (BANNED_SEGMENTS.has(segment)) {
      return segment;
    }
  }

  return null;
}

function literalViolations(source: EngineSource): PortabilityViolation[] {
  const sourceFile = ts.createSourceFile(source.file, source.source, ts.ScriptTarget.Latest, true);
  const violations: PortabilityViolation[] = [];

  const check = (literal: string): void => {
    const fragment = bannedFragment(literal);
    if (fragment !== null) {
      violations.push({ file: source.file, literal, fragment });
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      check(node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return violations;
}

/** Scans sources for repository-specific literals; sorted for stable output. */
function portabilityViolations(sources: readonly EngineSource[]): PortabilityViolation[] {
  return sources.flatMap(literalViolations).sort((left, right) => {
    if (left.file !== right.file) {
      return left.file < right.file ? -1 : 1;
    }
    return left.literal < right.literal ? -1 : left.literal > right.literal ? 1 : 0;
  });
}

/**
 * Source extensions the scanner treats as engine modules. `.mts`/`.cts` are
 * included so a future module cannot escape the guard by extension alone.
 */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * Test-file suffixes, exempt uniformly: they must name the real tree (the golden
 * test) and carry deliberate violations (this file). `.test.`/`.spec.` are both
 * honoured whatever the module extension.
 */
const TEST_INFIXES = [".test.", ".spec."] as const;

function hasSourceExtension(fileName: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(fileName));
}

function isTestSource(fileName: string): boolean {
  return TEST_INFIXES.some((infix) => fileName.includes(infix));
}

/** Reads non-test engine sources under `directory`, relative to `base`. */
function readEngineSources(directory: string, base: string = directory): EngineSource[] {
  const sources: EngineSource[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      sources.push(...readEngineSources(absolute, base));
      continue;
    }
    if (!hasSourceExtension(entry.name) || isTestSource(entry.name)) {
      continue;
    }

    sources.push({
      file: path.relative(base, absolute),
      source: readFileSync(absolute, "utf8"),
    });
  }

  return sources.sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0,
  );
}

describe("engine portability", () => {
  it("keeps every non-test engine source free of repository literals", () => {
    const sources = readEngineSources(ENGINE_DIRECTORY);

    // Non-vacuous floor: the scanner must actually be reading the engine.
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(sources.map((source) => source.file)).toContain("build-graph.ts");
    expect(sources.map((source) => source.file)).toContain("fixture-harness.ts");

    expect(portabilityViolations(sources)).toEqual([]);
  });

  it("fails on a deliberate violation fixture (in memory)", () => {
    // Built by joining so this test file has no literal `${` for Biome's
    // noTemplateCurlyInString rule to flag; the fixture source still parses as
    // a template expression with a `factory/` head.
    const templateViolation = ["export const where = `factory/", "$", "{segment}`;\n"].join("");

    expect(
      portabilityViolations([
        { file: "violation.ts", source: 'export const where = "packages/core/src";\n' },
        { file: "package-name.ts", source: 'export const dep = "@trailstep/core";\n' },
        { file: "template.ts", source: templateViolation },
      ]),
    ).toEqual([
      { file: "package-name.ts", literal: "@trailstep/core", fragment: "trailstep" },
      { file: "template.ts", literal: "factory/", fragment: "factory" },
      { file: "violation.ts", literal: "packages/core/src", fragment: "packages" },
    ]);
  });

  it("fails on a deliberate violation fixture (temp directory)", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "arch-portability-probe-"));

    try {
      writeFileSync(
        path.join(directory, "violation.ts"),
        'export const where = "factory/arch";\n',
        "utf8",
      );
      writeFileSync(
        path.join(directory, "allowed.test.ts"),
        'export const where = "packages/core/src";\n',
        "utf8",
      );

      const sources = readEngineSources(directory);
      expect(sources.map((source) => source.file)).toEqual(["violation.ts"]);
      expect(portabilityViolations(sources)).toEqual([
        { file: "violation.ts", literal: "factory/arch", fragment: "factory" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("scans .mts/.cts modules and exempts .spec files like .test files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "arch-portability-ext-"));

    try {
      for (const file of ["module.mts", "module.cts", "named.spec.ts", "plain.spec.cts"]) {
        writeFileSync(path.join(directory, file), 'export const where = "runs/store";\n', "utf8");
      }

      expect(readEngineSources(directory).map((source) => source.file)).toEqual([
        "module.cts",
        "module.mts",
      ]);
      expect(portabilityViolations(readEngineSources(directory))).toEqual([
        { file: "module.cts", literal: "runs/store", fragment: "runs" },
        { file: "module.mts", literal: "runs/store", fragment: "runs" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
