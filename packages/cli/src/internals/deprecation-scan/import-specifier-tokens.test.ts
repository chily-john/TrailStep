import { describe, expect, it } from "vitest";

import { extractTrailStepImportTokens } from "./import-specifier-tokens.js";

describe("extractTrailStepImportTokens", () => {
  it("extracts a single named import bound to @trailstep/core", () => {
    const tokens = extractTrailStepImportTokens('import { step } from "@trailstep/core";\n');

    expect(tokens).toEqual([{ packageName: "@trailstep/core", symbol: "step", offset: 9 }]);
  });

  it("extracts multiple named imports from a single clause", () => {
    const tokens = extractTrailStepImportTokens('import { step, done } from "@trailstep/core";\n');

    expect(tokens.map((token) => token.symbol)).toEqual(["step", "done"]);
    expect(tokens.every((token) => token.packageName === "@trailstep/core")).toBe(true);
  });

  it("extracts named imports bound to @trailstep/authoring", () => {
    const tokens = extractTrailStepImportTokens('import { step } from "@trailstep/authoring";\n');

    expect(tokens).toEqual([{ packageName: "@trailstep/authoring", symbol: "step", offset: 9 }]);
  });

  it("ignores imports from unrelated packages", () => {
    const tokens = extractTrailStepImportTokens('import { step } from "@acme/workflows";\n');

    expect(tokens).toEqual([]);
  });

  it("skips aliased named imports (known limitation)", () => {
    const tokens = extractTrailStepImportTokens('import { step as s } from "@trailstep/core";\n');

    expect(tokens).toEqual([]);
  });

  it("handles a type-only named import prefix", () => {
    const tokens = extractTrailStepImportTokens(
      'import { type StepConfig, step } from "@trailstep/core";\n',
    );

    expect(tokens.map((token) => token.symbol)).toEqual(["StepConfig", "step"]);
  });

  it("reports the correct offset for a symbol on a later line", () => {
    const source = '// comment\nimport {\n  step,\n} from "@trailstep/core";\n';
    const tokens = extractTrailStepImportTokens(source);

    expect(tokens).toHaveLength(1);
    expect(source.slice(tokens[0]?.offset, (tokens[0]?.offset ?? 0) + 4)).toBe("step");
  });
});
