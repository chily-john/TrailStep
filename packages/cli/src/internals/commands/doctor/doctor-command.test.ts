import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tmpDir(task: { readonly id: string }, variant: string): string {
  return join("node_modules", ".tmp-stepkit-doctor-command-tests", `${task.id}-${variant}`);
}

async function createBundleWorkflow(cwd: string, source: string): Promise<void> {
  const packageDir = join(cwd, "node_modules", "@acme", "bundle");
  await writeJson(join(packageDir, "package.json"), {
    name: "@acme/bundle",
    version: "1.0.0",
    main: "./index.mjs",
    keywords: ["stepkit-workflow"],
    stepkit: { workflows: { release: "./index.mjs#release" } },
  });
  await writeFile(join(packageDir, "index.mjs"), source, "utf8");
  await writeJson(join(cwd, ".stepkit", "config.json"), {
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
    expect(lines).toEqual(["No StepKit deprecation findings."]);
    expect(errors).toEqual([]);
  });

  it("uses installed manifest versions for warning detection", async ({ task }) => {
    const cwd = tmpDir(task, "installed-manifest-warning");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/core": "^1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@stepkit", "core", "package.json"), {
      name: "@stepkit/core",
      version: "2.0.0",
    });
    await createBundleWorkflow(
      cwd,
      "import { oldStep } from '@stepkit/core';\nexport const release = oldStep;\n",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@stepkit/core",
          symbol: "oldStep",
          deprecatedSince: "2.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("warning @stepkit/core/oldStep");
    expect(errors.join("\n")).toMatch(/deprecation warnings/i);
  });

  it("exits 2 when the manifest entry's removedIn is at or below the installed core version", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "blocking");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/core": "1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@stepkit", "core", "package.json"), {
      name: "@stepkit/core",
      version: "1.0.0",
    });
    await createBundleWorkflow(
      cwd,
      "import { oldStep } from '@stepkit/core';\nexport const release = oldStep;\n",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@stepkit/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          removedIn: "1.0.0",
          message: "oldStep was removed.",
        },
      ],
    });

    expect(exitCode).toBe(2);
    expect(lines.join("\n")).toContain("blocking @stepkit/core/oldStep");
    expect(errors.join("\n")).toMatch(/blocking deprecation findings/i);
  });

  it("scans registered direct-file workflow sources", async ({ task }) => {
    const cwd = tmpDir(task, "direct-file");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/core": "1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@stepkit", "core", "package.json"), {
      name: "@stepkit/core",
      version: "1.0.0",
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "import { oldStep } from '@stepkit/core';\nexport const review = oldStep;\n",
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
          packageName: "@stepkit/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("warning @stepkit/core/oldStep");
    expect(lines.join("\n")).toContain("workflows/review.mjs");
    expect(errors).toEqual(["Doctor found deprecation warnings."]);
  });

  it("prints clean output and exits zero when no findings exist", async ({ task }) => {
    const cwd = tmpDir(task, "clean-registered");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/core": "1.0.0" },
    });
    await createBundleWorkflow(
      cwd,
      "import { step } from '@stepkit/core';\nexport const release = step;\n",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@stepkit/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["No StepKit deprecation findings."]);
    expect(errors).toEqual([]);
  });

  it("skips unreadable targets without crashing", async ({ task }) => {
    const cwd = tmpDir(task, "unreadable-target");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/core": "1.0.0" },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
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
          packageName: "@stepkit/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["No StepKit deprecation findings."]);
    expect(errors).toEqual([]);
  });

  it("does not detect an aliased import even when a matching manifest entry exists", async ({
    task,
  }) => {
    const cwd = tmpDir(task, "aliased");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/core": "1.0.0" },
    });
    await createBundleWorkflow(
      cwd,
      "import { oldStep as os } from '@stepkit/core';\nexport const release = os;\n",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [
        {
          packageName: "@stepkit/core",
          symbol: "oldStep",
          deprecatedSince: "1.0.0",
          message: "oldStep is deprecated.",
        },
      ],
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["No StepKit deprecation findings."]);
    expect(errors).toEqual([]);
  });
});
