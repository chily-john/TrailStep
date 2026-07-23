import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scanWorkflowSourceForDeprecations } from "./deprecation-scanner.js";

async function writeSource(cwd: string, contents: string): Promise<string> {
  await mkdir(cwd, { recursive: true });
  const sourceFile = join(cwd, "workflow.mjs");
  await writeFile(sourceFile, contents, "utf8");
  return sourceFile;
}

function tmpDir(task: { readonly id: string }, variant: string): string {
  return join("node_modules", ".tmp-stepkit-deprecation-scanner-tests", `${task.id}-${variant}`);
}

describe("scanWorkflowSourceForDeprecations", () => {
  it("produces no findings for a clean source with no matching manifest entries", async ({
    task,
  }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "clean"),
      "import { step } from '@stepkit/sdk';\nexport const review = step;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@stepkit/sdk", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@stepkit/sdk",
          symbol: "unrelatedSymbol",
          deprecatedSince: "1.0.0",
          message: "unrelatedSymbol is deprecated.",
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it("produces one warning finding for a source matching a warning-tier manifest entry", async ({
    task,
  }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "warning"),
      "import { oldStep } from '@stepkit/sdk';\nexport const review = oldStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@stepkit/sdk", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@stepkit/sdk",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
          replacement: "step",
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      sourceFile,
      packageName: "@stepkit/sdk",
      symbol: "oldStep",
      severity: "warning",
      message: "oldStep is deprecated.",
      replacement: "step",
      line: 1,
      targetVersion: "2.0.0",
      newlyTriggeredByThisUpdate: false,
    });
    expect(findings[0]?.installedVersion).toBeUndefined();
  });

  it("produces one blocking finding for a source matching a blocking-tier manifest entry", async ({
    task,
  }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "blocking"),
      "import { removedStep } from '@stepkit/sdk';\nexport const review = removedStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@stepkit/sdk", { targetVersion: "1.0.0" }]]),
      manifest: [
        {
          packageName: "@stepkit/sdk",
          symbol: "removedStep",
          deprecatedSince: "0.5.0",
          removedIn: "1.0.0",
          message: "removedStep was removed.",
          replacement: "step",
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      packageName: "@stepkit/sdk",
      symbol: "removedStep",
      severity: "blocking",
      message: "removedStep was removed.",
      replacement: "step",
    });
  });

  it("does not detect aliased imports (known limitation)", async ({ task }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "aliased"),
      "import { step as s } from '@stepkit/sdk';\nexport const review = s;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@stepkit/sdk", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@stepkit/sdk",
          symbol: "step",
          deprecatedSince: "1.0.0",
          message: "step is deprecated.",
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it("marks newlyTriggeredByThisUpdate false when installedVersion already had the same severity as targetVersion", async ({
    task,
  }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "not-newly-triggered"),
      "import { oldStep } from '@stepkit/sdk';\nexport const review = oldStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([
        ["@stepkit/sdk", { installedVersion: "1.5.0", targetVersion: "2.0.0" }],
      ]),
      manifest: [
        {
          packageName: "@stepkit/sdk",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.installedVersion).toBe("1.5.0");
    expect(findings[0]?.newlyTriggeredByThisUpdate).toBe(false);
  });
});
