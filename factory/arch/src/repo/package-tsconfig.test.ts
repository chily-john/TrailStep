import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_EXTENDS,
  CANONICAL_INCLUDE_ENTRY,
  describePackageTsconfigViolations,
  type PackageTsconfigShape,
  packageTsconfigViolations,
  SHARED_FORBIDDEN_COMPILER_OPTIONS,
  sharedTsconfigViolations,
} from "./package-tsconfig.js";
import { findRepoRoot } from "./root.js";

/** The only sanctioned non-canonical config: Svelte needs Bundler resolution and Svelte types. */
const DASHBOARD_EXEMPTION = new Map([
  ["packages/dashboard", "Svelte/Vite app needs moduleResolution: Bundler and Svelte types."],
]);

const WORKSPACE_ROOTS = ["packages", "factory"];

const repoRoot = findRepoRoot();

/** Directories under `packages/` and `factory/` that hold a package manifest. */
function workspacePackageDirectories(): string[] {
  const directories: string[] = [];

  for (const workspaceRoot of WORKSPACE_ROOTS) {
    for (const entry of readdirSync(join(repoRoot, workspaceRoot), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = `${workspaceRoot}/${entry.name}`;
      try {
        readFileSync(join(repoRoot, directory, "package.json"));
      } catch {
        continue;
      }
      directories.push(directory);
    }
  }

  return directories.sort();
}

/**
 * Parses tsconfig text as JSONC: `tsc` accepts comments and trailing commas,
 * so a bare `JSON.parse` would fail a config the compiler is happy with.
 */
function parsePackageTsconfig(source: string, configPath: string): PackageTsconfigShape {
  const { config, error } = ts.parseConfigFileTextToJson(configPath, source);

  if (error || config === undefined) {
    const detail = error
      ? `TS${error.code}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`
      : "the file is empty";
    throw new Error(`${configPath}: could not be read as a tsconfig (${detail}).`);
  }

  return config as PackageTsconfigShape;
}

function readPackageTsconfig(directory: string): PackageTsconfigShape {
  const configPath = `${directory}/tsconfig.json`;

  return parsePackageTsconfig(readFileSync(join(repoRoot, configPath), "utf8"), configPath);
}

function canonicalConfig(
  overrides: Partial<PackageTsconfigShape> & { compilerOptions?: Record<string, unknown> } = {},
): PackageTsconfigShape {
  return {
    extends: CANONICAL_EXTENDS,
    include: [CANONICAL_INCLUDE_ENTRY],
    compilerOptions: { rootDir: "src", outDir: "dist" },
    ...overrides,
  };
}

function violationKeys(config: PackageTsconfigShape): string[] {
  return packageTsconfigViolations(config).map((violation) => violation.key);
}

describe("package tsconfigs", () => {
  it("keeps every package tsconfig in the canonical shape", () => {
    const failures: string[] = [];

    for (const directory of workspacePackageDirectories()) {
      if (DASHBOARD_EXEMPTION.has(directory)) {
        continue;
      }

      const configPath = `${directory}/tsconfig.json`;
      const violations = packageTsconfigViolations(readPackageTsconfig(directory));
      if (violations.length > 0) {
        failures.push(describePackageTsconfigViolations(configPath, violations));
      }
    }

    expect(failures.join("\n")).toBe("");
  });

  it("documents exactly one exemption", () => {
    expect([...DASHBOARD_EXEMPTION.keys()]).toEqual(["packages/dashboard"]);
    expect(workspacePackageDirectories()).toContain("packages/dashboard");
  });

  it("reads JSONC tsconfigs", () => {
    const source = `{
      // comments and trailing commas are valid in tsconfig.json
      "extends": "${CANONICAL_EXTENDS}",
      "include": ["${CANONICAL_INCLUDE_ENTRY}"],
      "compilerOptions": { "rootDir": "src", "outDir": "dist" },
    }`;

    const config = parsePackageTsconfig(source, "packages/fixture/tsconfig.json");

    expect(packageTsconfigViolations(config)).toEqual([]);
  });

  it("names a tsconfig it cannot read", () => {
    expect(() => parsePackageTsconfig('{ "extends": }', "packages/fixture/tsconfig.json")).toThrow(
      /packages\/fixture\/tsconfig\.json: could not be read as a tsconfig \(TS\d+/u,
    );
  });

  it("rejects a widened rootDir", () => {
    expect(
      violationKeys(canonicalConfig({ compilerOptions: { rootDir: "..", outDir: "dist" } })),
    ).toEqual(["compilerOptions.rootDir"]);

    const message = describePackageTsconfigViolations(
      "packages/fixture/tsconfig.json",
      packageTsconfigViolations(canonicalConfig({ compilerOptions: { rootDir: ".." } })),
    );
    expect(message).toContain("packages/fixture/tsconfig.json");
    expect(message).toContain("compilerOptions.rootDir");
    expect(message).toContain('Fix: set "rootDir": "src"');
  });

  it.each(["paths", "baseUrl", "references", "composite"])("rejects compilerOptions.%s", (key) => {
    const config = canonicalConfig({
      compilerOptions: {
        rootDir: "src",
        outDir: "dist",
        [key]: { "@trailstep/core": ["../core/src/index.ts"] },
      },
    });

    expect(violationKeys(config)).toEqual([`compilerOptions.${key}`]);

    const message = describePackageTsconfigViolations(
      "packages/fixture/tsconfig.json",
      packageTsconfigViolations(config),
    );
    expect(message).toContain(`compilerOptions.${key}`);
    expect(message).toContain("reach-in protection comes from package.json#exports");
  });

  it("tolerates benign compiler options", () => {
    const config = canonicalConfig({
      compilerOptions: { rootDir: "src", outDir: "dist", verbatimModuleSyntax: true },
    });

    expect(violationKeys(config)).toEqual([]);
  });
});

/** The two configs every package inherits from or shares with the repo root. */
const SHARED_CONFIG_PATHS = ["tsconfig.base.json", "tsconfig.json"];

/** The strict flags the base config must keep; carried here to prove they are benign. */
const BASE_STRICT_FLAGS = {
  verbatimModuleSyntax: true,
  noUncheckedSideEffectImports: true,
  moduleDetection: "force",
  noImplicitOverride: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  erasableSyntaxOnly: true,
};

function sharedViolationKeys(config: PackageTsconfigShape): string[] {
  return sharedTsconfigViolations(config).map((violation) => violation.key);
}

describe("shared base and root tsconfigs", () => {
  it("keeps the base and root configs free of reach-in keys", () => {
    const failures: string[] = [];

    for (const configPath of SHARED_CONFIG_PATHS) {
      const config = parsePackageTsconfig(
        readFileSync(join(repoRoot, configPath), "utf8"),
        configPath,
      );
      const violations = sharedTsconfigViolations(config);

      if (violations.length > 0) {
        failures.push(describePackageTsconfigViolations(configPath, violations));
      }
    }

    expect(failures.join("\n")).toBe("");
  });

  it("accepts a clean base config carrying the strict flags", () => {
    expect(sharedViolationKeys({ compilerOptions: { ...BASE_STRICT_FLAGS } })).toEqual([]);
  });

  it("tolerates benign compiler options next to the strict flags", () => {
    expect(
      sharedViolationKeys({
        compilerOptions: { ...BASE_STRICT_FLAGS, skipLibCheck: true, target: "ES2022" },
      }),
    ).toEqual([]);
  });

  it.each(SHARED_CONFIG_PATHS)("rejects every forbidden key in %s", (configPath) => {
    for (const key of SHARED_FORBIDDEN_COMPILER_OPTIONS) {
      const violations = sharedTsconfigViolations({ compilerOptions: { [key]: ["fixture"] } });

      expect(violations.map((violation) => violation.key)).toEqual([`compilerOptions.${key}`]);

      const message = describePackageTsconfigViolations(configPath, violations);
      expect(message).toContain(`${configPath}: compilerOptions.${key}`);
      expect(message).toContain("per-package package.json#exports");
      expect(message).toContain("every package at once");
    }

    const topLevelReferences = sharedTsconfigViolations({
      compilerOptions: {},
      references: [{ path: "./packages/core" }],
    });

    expect(topLevelReferences.map((violation) => violation.key)).toEqual(["references"]);
    expect(describePackageTsconfigViolations(configPath, topLevelReferences)).toContain(
      `${configPath}: references`,
    );
  });
});
