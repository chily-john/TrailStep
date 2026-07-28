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
      "import { step } from '@stepkit/authoring';\nexport const review = step;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@stepkit/authoring", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@stepkit/authoring",
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
      "import { oldStep } from '@stepkit/authoring';\nexport const review = oldStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@stepkit/authoring", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@stepkit/authoring",
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
      packageName: "@stepkit/authoring",
      symbol: "oldStep",
      severity: "warning",
      message: "oldStep is deprecated.",
      replacement: "step",
      line: 1,
      targetVersion: "2.0.0",
      newlyTriggeredByThisUpdate: true,
    });
    expect(findings[0]?.installedVersion).toBeUndefined();
  });

  it("produces one blocking finding for a source matching a blocking-tier manifest entry", async ({
    task,
  }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "blocking"),
      "import { removedStep } from '@stepkit/authoring';\nexport const review = removedStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@stepkit/authoring", { targetVersion: "1.0.0" }]]),
      manifest: [
        {
          packageName: "@stepkit/authoring",
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
      packageName: "@stepkit/authoring",
      symbol: "removedStep",
      severity: "blocking",
      message: "removedStep was removed.",
      replacement: "step",
    });
  });

  it("does not detect aliased imports (known limitation)", async ({ task }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "aliased"),
      "import { step as s } from '@stepkit/authoring';\nexport const review = s;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@stepkit/authoring", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@stepkit/authoring",
          symbol: "step",
          deprecatedSince: "1.0.0",
          message: "step is deprecated.",
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it("marks newlyTriggeredByThisUpdate true when an update turns a warning into blocking", async ({
    task,
  }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "warning-to-blocking"),
      "import { removedStep } from '@stepkit/core';\nexport const review = removedStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([
        ["@stepkit/core", { installedVersion: "2.5.0", targetVersion: "3.0.0" }],
      ]),
      manifest: [
        {
          packageName: "@stepkit/core",
          symbol: "removedStep",
          deprecatedSince: "2.0.0",
          removedIn: "3.0.0",
          message: "removedStep was removed.",
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      packageName: "@stepkit/core",
      symbol: "removedStep",
      severity: "blocking",
      installedVersion: "2.5.0",
      targetVersion: "3.0.0",
      newlyTriggeredByThisUpdate: true,
    });
  });

  it("does not scan packages outside @stepkit/core and @stepkit/authoring", async ({ task }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "unsupported-package"),
      "import { legacyCommand } from '@stepkit/cli';\nexport const review = legacyCommand;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@stepkit/cli", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@stepkit/cli",
          symbol: "legacyCommand",
          deprecatedSince: "1.0.0",
          message: "legacyCommand is deprecated.",
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
      "import { oldStep } from '@stepkit/authoring';\nexport const review = oldStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([
        ["@stepkit/authoring", { installedVersion: "1.5.0", targetVersion: "2.0.0" }],
      ]),
      manifest: [
        {
          packageName: "@stepkit/authoring",
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
