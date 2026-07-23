import { describe, expect, it } from "vitest";

import { extractStepKitImportTokens } from "./import-specifier-tokens.js";

describe("extractStepKitImportTokens", () => {
  it("extracts a single named import bound to @stepkit/core", () => {
    const tokens = extractStepKitImportTokens('import { step } from "@stepkit/core";\n');

    expect(tokens).toEqual([{ packageName: "@stepkit/core", symbol: "step", offset: 9 }]);
  });

  it("extracts multiple named imports from a single clause", () => {
    const tokens = extractStepKitImportTokens('import { step, done } from "@stepkit/core";\n');

    expect(tokens.map((token) => token.symbol)).toEqual(["step", "done"]);
    expect(tokens.every((token) => token.packageName === "@stepkit/core")).toBe(true);
  });

  it("extracts named imports bound to @stepkit/sdk", () => {
    const tokens = extractStepKitImportTokens('import { step } from "@stepkit/sdk";\n');

    expect(tokens).toEqual([{ packageName: "@stepkit/sdk", symbol: "step", offset: 9 }]);
  });

  it("ignores imports from unrelated packages", () => {
    const tokens = extractStepKitImportTokens('import { step } from "@acme/workflows";\n');

    expect(tokens).toEqual([]);
  });

  it("skips aliased named imports (known limitation)", () => {
    const tokens = extractStepKitImportTokens('import { step as s } from "@stepkit/core";\n');

    expect(tokens).toEqual([]);
  });

  it("handles a type-only named import prefix", () => {
    const tokens = extractStepKitImportTokens(
      'import { type StepConfig, step } from "@stepkit/core";\n',
    );

    expect(tokens.map((token) => token.symbol)).toEqual(["StepConfig", "step"]);
  });

  it("reports the correct offset for a symbol on a later line", () => {
    const source = '// comment\nimport {\n  step,\n} from "@stepkit/core";\n';
    const tokens = extractStepKitImportTokens(source);

    expect(tokens).toHaveLength(1);
    expect(source.slice(tokens[0]?.offset, (tokens[0]?.offset ?? 0) + 4)).toBe("step");
  });
});
