import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..", "..");

const compatibilityTestFiles = [
  "packages/core/src/engine/step-kinds/run-agent-step.test.ts",
  "packages/core/src/engine/step-kinds/run-interactive-step.test.ts",
  "packages/core/src/engine/step-kinds/run-interactive-step-file-output.test.ts",
  "packages/core/src/engine/runtime-failures.test.ts",
  "packages/sdk/src/prompts.test.ts",
];

const primaryDocFiles = [
  "README.md",
  "docs/architecture.md",
  "docs/runtime.md",
  "docs/sdk.md",
  "docs/roadmap.md",
  "packages/core/README.md",
  "packages/cli/README.md",
];

describe("static workflow model cleanup", () => {
  it("labels remaining static step-list tests as deprecated compatibility coverage", async () => {
    await Promise.all(
      compatibilityTestFiles.map(async (relativePath) => {
        const contents = await readFile(join(repositoryRoot, relativePath), "utf8");
        if (!contents.includes("steps:")) {
          return;
        }

        expect(contents, `${relativePath} should de-emphasize static steps`).toContain(
          "deprecated static workflow compatibility",
        );
      }),
    );
  });

  it("keeps primary documentation from teaching defineStep examples", async () => {
    await Promise.all(
      primaryDocFiles.map(async (relativePath) => {
        const contents = await readFile(join(repositoryRoot, relativePath), "utf8");
        expect(contents, `${relativePath} should not include defineStep calls`).not.toMatch(
          /defineStep\s*\(/,
        );
      }),
    );
  });
});
