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
  return join("node_modules", ".tmp-trailstep-deprecation-scanner-tests", `${task.id}-${variant}`);
}

describe("scanWorkflowSourceForDeprecations", () => {
  it("produces no findings for a clean source with no matching manifest entries", async ({
    task,
  }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "clean"),
      "import { step } from '@trailstep/authoring';\nexport const review = step;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@trailstep/authoring", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@trailstep/authoring",
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
      "import { oldStep } from '@trailstep/authoring';\nexport const review = oldStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@trailstep/authoring", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@trailstep/authoring",
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
      packageName: "@trailstep/authoring",
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
      "import { removedStep } from '@trailstep/authoring';\nexport const review = removedStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@trailstep/authoring", { targetVersion: "1.0.0" }]]),
      manifest: [
        {
          packageName: "@trailstep/authoring",
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
      packageName: "@trailstep/authoring",
      symbol: "removedStep",
      severity: "blocking",
      message: "removedStep was removed.",
      replacement: "step",
    });
  });

  it("does not detect aliased imports (known limitation)", async ({ task }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "aliased"),
      "import { step as s } from '@trailstep/authoring';\nexport const review = s;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@trailstep/authoring", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@trailstep/authoring",
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
      "import { removedStep } from '@trailstep/core';\nexport const review = removedStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([
        ["@trailstep/core", { installedVersion: "2.5.0", targetVersion: "3.0.0" }],
      ]),
      manifest: [
        {
          packageName: "@trailstep/core",
          symbol: "removedStep",
          deprecatedSince: "2.0.0",
          removedIn: "3.0.0",
          message: "removedStep was removed.",
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      packageName: "@trailstep/core",
      symbol: "removedStep",
      severity: "blocking",
      installedVersion: "2.5.0",
      targetVersion: "3.0.0",
      newlyTriggeredByThisUpdate: true,
    });
  });

  it("does not scan packages outside @trailstep/core and @trailstep/authoring", async ({ task }) => {
    const sourceFile = await writeSource(
      tmpDir(task, "unsupported-package"),
      "import { legacyCommand } from '@trailstep/cli';\nexport const review = legacyCommand;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([["@trailstep/cli", { targetVersion: "2.0.0" }]]),
      manifest: [
        {
          packageName: "@trailstep/cli",
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
      "import { oldStep } from '@trailstep/authoring';\nexport const review = oldStep;\n",
    );

    const findings = await scanWorkflowSourceForDeprecations({
      sourceFile,
      versionsByPackageName: new Map([
        ["@trailstep/authoring", { installedVersion: "1.5.0", targetVersion: "2.0.0" }],
      ]),
      manifest: [
        {
          packageName: "@trailstep/authoring",
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
