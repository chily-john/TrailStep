import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tmpDir(task: { readonly id: string }, variant: string): string {
  return join("node_modules", ".tmp-trailstep-doctor-command-tests", `${task.id}-${variant}`);
}

async function createBundleWorkflow(cwd: string, source: string): Promise<void> {
  const packageDir = join(cwd, "node_modules", "@acme", "bundle");
  await writeJson(join(packageDir, "package.json"), {
    name: "@acme/bundle",
    version: "1.0.0",
    main: "./index.mjs",
    keywords: ["trailstep-workflow"],
    trailstep: { workflows: { release: "./index.mjs#release" } },
  });
  await writeFile(join(packageDir, "index.mjs"), source, "utf8");
  await writeJson(join(cwd, ".trailstep", "config.json"), {
    workflows: { project: { release: "@acme/bundle#release" } },
  });
}

describe("doctor command", () => {
  it("reports no findings and exits 0 when there is no config and nothing to discover", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "no-config");
    await mkdir(cwd, { recursive: true });
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["No TrailStep deprecation findings."]);
    expect(errors).toEqual([]);
  });

  it("uses installed manifest versions for warning detection", async ({ task }) => {
    const cwd = tmpDir(task, "installed-manifest-warning");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "^1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@trailstep", "core", "package.json"), {
      name: "@trailstep/core",
      version: "2.0.0",
    });
    await createBundleWorkflow(
      cwd,
      "import { oldStep } from '@trailstep/core';\nexport const release = oldStep;\n",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@trailstep/core",
          symbol: "oldStep",
          deprecatedSince: "2.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("warning @trailstep/core/oldStep");
    expect(errors.join("\n")).toMatch(/deprecation warnings/i);
  });

  it("exits 2 when the manifest entry's removedIn is at or below the installed core version", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "blocking");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@trailstep", "core", "package.json"), {
      name: "@trailstep/core",
      version: "1.0.0",
    });
    await createBundleWorkflow(
      cwd,
      "import { oldStep } from '@trailstep/core';\nexport const release = oldStep;\n",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@trailstep/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          removedIn: "1.0.0",
          message: "oldStep was removed.",
        },
      ],
    });

    expect(exitCode).toBe(2);
    expect(lines.join("\n")).toContain("blocking @trailstep/core/oldStep");
    expect(errors.join("\n")).toMatch(/blocking deprecation findings/i);
  });

  it("scans registered direct-file workflow sources", async ({ task }) => {
    const cwd = tmpDir(task, "direct-file");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@trailstep", "core", "package.json"), {
      name: "@trailstep/core",
      version: "1.0.0",
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "import { oldStep } from '@trailstep/core';\nexport const review = oldStep;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@trailstep/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("warning @trailstep/core/oldStep");
    expect(lines.join("\n")).toContain("workflows/review.mjs");
    expect(errors).toEqual(["Doctor found deprecation warnings."]);
  });

  it("scans deprecations in a global package-backed workflow", async ({ task }) => {
    const cwd = tmpDir(task, "global-package-backed");
    const homeDir = tmpDir(task, "global-package-backed-home");
    const packageDir = join(
      homeDir,
      ".trailstep",
      "packages",
      "node_modules",
      "@acme",
      "workflows",
    );
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@trailstep", "core", "package.json"), {
      name: "@trailstep/core",
      version: "1.0.0",
    });
    await writeJson(join(homeDir, ".trailstep", "config.json"), {
      workflows: { global: { review: "@acme/workflows#review" } },
      workflowMetadata: {
        global: {
          review: {
            kind: "package",
            sourceType: "npm",
            packageName: "@acme/workflows",
            requestedSpec: "@acme/workflows@^1.2.3",
            requestedRange: "^1.2.3",
            installScope: "global",
            targetRef: "@acme/workflows#review",
            workflowName: "review",
            exportName: "reviewWorkflow",
          },
        },
      },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      version: "1.2.3",
      trailstep: {
        workflows: {
          review: "./dist/review.mjs#reviewWorkflow",
        },
      },
    });
    await mkdir(join(packageDir, "dist"), { recursive: true });
    await writeFile(
      join(packageDir, "dist", "review.mjs"),
      "import { oldStep } from '@trailstep/core';\nexport const review = oldStep;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      homeDir,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@trailstep/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("warning @trailstep/core/oldStep");
    expect(lines.join("\n")).toContain(
      ".trailstep/packages/node_modules/@acme/workflows/dist/review.mjs",
    );
    expect(errors).toEqual(["Doctor found deprecation warnings."]);
  });

  it("prints clean output and exits zero when no findings exist", async ({ task }) => {
    const cwd = tmpDir(task, "clean-registered");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "1.0.0" },
    });
    await createBundleWorkflow(
      cwd,
      "import { step } from '@trailstep/core';\nexport const release = step;\n",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@trailstep/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["No TrailStep deprecation findings."]);
    expect(errors).toEqual([]);
  });

  it("skips unreadable targets without crashing", async ({ task }) => {
    const cwd = tmpDir(task, "unreadable-target");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { missing: "./workflows/missing.mjs" } },
    });
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@trailstep/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["No TrailStep deprecation findings."]);
    expect(errors).toEqual([]);
  });

  it("does not detect an aliased import even when a matching manifest entry exists", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "aliased");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "1.0.0" },
    });
    await createBundleWorkflow(
      cwd,
      "import { oldStep as os } from '@trailstep/core';\nexport const release = os;\n",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@trailstep/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["No TrailStep deprecation findings."]);
    expect(errors).toEqual([]);
  });
});
