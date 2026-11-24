import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "./root.js";
import {
  BASE_TSCONFIG,
  type TurboConfigShape,
  turboCacheInputViolations,
} from "./turbo-cache-inputs.js";

const TURBO_CONFIG_PATH = "turbo.json";

/**
 * Turbo-root-anchored spelling of the base tsconfig. turbo 2.10.10 rejects it in
 * `globalDependencies` ("cannot contain an environment variable"); `$TURBO_ROOT$`
 * only works in `tasks.*.inputs` globs.
 */
const TURBO_ROOT_BASE_TSCONFIG = `$TURBO_ROOT$/${BASE_TSCONFIG}`;

const repoRoot = findRepoRoot();

/**
 * Parses tsconfig-style JSONC: Turbo accepts comments and trailing commas, so a
 * bare `JSON.parse` would reject a config Turbo itself reads happily.
 */
function parseTurboConfig(source: string): TurboConfigShape {
  const { config, error } = ts.parseConfigFileTextToJson(TURBO_CONFIG_PATH, source);

  if (error || config === undefined) {
    const detail = error
      ? `TS${error.code}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`
      : "the file is empty";
    throw new Error(`${TURBO_CONFIG_PATH}: could not be read as a turbo config (${detail}).`);
  }

  return config as TurboConfigShape;
}

function violationMessages(config: TurboConfigShape): string[] {
  return turboCacheInputViolations(config).map((violation) => violation.message);
}

describe("turbo cache inputs", () => {
  it("hashes the root base tsconfig", () => {
    const config = parseTurboConfig(readFileSync(join(repoRoot, TURBO_CONFIG_PATH), "utf8"));

    expect(violationMessages(config).join("\n")).toBe("");
  });

  // turbo 2.10.10 rejects env-var prefixes in globalDependencies, so this spelling cannot load.
  it("rejects the turbo-root-anchored spelling", () => {
    const messages = violationMessages({ globalDependencies: [TURBO_ROOT_BASE_TSCONFIG] });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("turbo.json: globalDependencies");
  });

  it("accepts extra global dependencies next to the base tsconfig", () => {
    expect(violationMessages({ globalDependencies: [BASE_TSCONFIG, "other"] })).toEqual([]);
  });

  it.each([
    ["a missing field", {}],
    ["an empty array", { globalDependencies: [] }],
    ["an unrelated list", { globalDependencies: ["pnpm-lock.yaml"] }],
    ["a non-array value", { globalDependencies: BASE_TSCONFIG }],
  ])("rejects %s", (_label, config) => {
    const messages = violationMessages(config);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("turbo.json: globalDependencies");
    expect(messages[0]).toContain(
      "per-package task hashes exclude the root base tsconfig, so a flag change would replay stale cache",
    );
    expect(messages[0]).toContain('add "tsconfig.base.json" to globalDependencies');
  });
});
