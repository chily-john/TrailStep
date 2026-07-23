import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { rewritePackageJsonDependencies } from "./package-json-rewrite.js";

describe("rewritePackageJsonDependencies", () => {
  it("preserves caret, tilde, and exact dependency range styles", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-package-json-rewrite-tests", task.id);
    await mkdir(cwd, { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(
        {
          dependencies: {
            "@stepkit/core": "^1.0.0",
            "@stepkit/sdk": "~1.0.0",
          },
          devDependencies: {
            "@stepkit/cli": "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await rewritePackageJsonDependencies({
      cwd,
      updates: [
        { packageName: "@stepkit/core", targetVersion: "2.0.0", dependencySection: "dependencies" },
        { packageName: "@stepkit/sdk", targetVersion: "2.0.0", dependencySection: "dependencies" },
        {
          packageName: "@stepkit/cli",
          targetVersion: "2.0.0",
          dependencySection: "devDependencies",
        },
      ],
    });

    const rewritten = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(rewritten.dependencies["@stepkit/core"]).toBe("^2.0.0");
    expect(rewritten.dependencies["@stepkit/sdk"]).toBe("~2.0.0");
    expect(rewritten.devDependencies["@stepkit/cli"]).toBe("2.0.0");
  });

  it("writes dependencies and devDependencies in the same sections they came from", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-package-json-rewrite-tests", task.id);
    await mkdir(cwd, { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(
        { dependencies: { "@stepkit/core": "^1.0.0" }, devDependencies: {} },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await rewritePackageJsonDependencies({
      cwd,
      updates: [
        { packageName: "@stepkit/core", targetVersion: "2.0.0", dependencySection: "dependencies" },
      ],
    });

    const rewritten = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(rewritten.dependencies["@stepkit/core"]).toBe("^2.0.0");
    expect(rewritten.devDependencies["@stepkit/core"]).toBeUndefined();
    expect(await readFile(packageJsonPath, "utf8")).toMatch(/\n$/u);
  });
});
