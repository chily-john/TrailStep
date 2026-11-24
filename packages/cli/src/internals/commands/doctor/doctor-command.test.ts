import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";
import { locateArchCli, summarizeArchCheck } from "./doctor-command.js";

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

  it("reports stale package recommended config", async ({ task }) => {
    const cwd = tmpDir(task, "recommended-config-drift");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      agents: { reviewer: [{ provider: "claude", model: "old" }] },
      workflows: { project: { review: "@acme/workflows#review" } },
      workflowMetadata: {
        project: {
          review: {
            kind: "package",
            sourceType: "npm",
            packageName: "@acme/workflows",
            requestedSpec: "@acme/workflows@^1.2.3",
            requestedRange: "^1.2.3",
            installScope: "project",
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
        workflows: { review: "./dist/review.mjs#reviewWorkflow" },
        recommendedConfig: {
          agents: {
            reviewer: [{ provider: "claude", model: "sonnet" }],
            implementer: [{ provider: "pi", model: "fast" }],
          },
          workflows: {
            review: {
              agents: {
                reviewer: [{ ref: "reviewer" }],
              },
            },
          },
        },
      },
    });
    await mkdir(join(packageDir, "dist"), { recursive: true });
    await writeFile(
      join(packageDir, "dist", "review.mjs"),
      "import { step } from '@trailstep/core';\nexport const review = step;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      deprecationManifest: [],
    });

    expect(exitCode).toBe(1);
    expect(lines).toContain(
      "Recommended config warning: @acme/workflows agents.reviewer differs from the package recommendation in project config.",
    );
    expect(lines).toContain(
      "Recommended config warning: @acme/workflows agents.implementer is missing in project config.",
    );
    expect(lines).toContain(
      "Recommended config warning: @acme/workflows workflows.review.agents.reviewer is missing in project config.",
    );
    expect(errors).toEqual(["Doctor found recommended config warnings."]);
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
  it("finds the arch CLI at the project root and reports an unbuilt factory", async ({ task }) => {
    const absent = tmpDir(task, "arch-absent");
    await mkdir(absent, { recursive: true });
    expect(await locateArchCli(absent)).toEqual({ status: "absent" });

    const unbuilt = tmpDir(task, "arch-unbuilt");
    await writeJson(join(unbuilt, "factory", "arch", "package.json"), { name: "x" });
    expect(await locateArchCli(unbuilt)).toEqual({ status: "unbuilt" });

    const ready = tmpDir(task, "arch-ready");
    await writeJson(join(ready, "factory", "arch", "package.json"), { name: "x" });
    await mkdir(join(ready, "factory", "arch", "dist"), { recursive: true });
    await writeFile(join(ready, "factory", "arch", "dist", "cli.js"), "", "utf8");
    expect(await locateArchCli(ready)).toEqual({
      status: "ready",
      cliPath: join(ready, "factory", "arch", "dist", "cli.js"),
    });
  });

  it("renders one arch verdict per state without ever gating", () => {
    const ready = { status: "ready", cliPath: "/repo/factory/arch/dist/cli.js" } as const;
    const diagnostic = {
      rule: "G8",
      file: "packages/core/src/authoring/x.ts",
      line: 12,
      message: "Reach-in at contracts/owner/private.ts.",
      fix: "Import the owner's front door, not a private sibling.",
    };

    expect(summarizeArchCheck({ status: "absent" }, null)).toEqual([]);
    expect(summarizeArchCheck({ status: "unbuilt" }, null).join("\n")).toContain(
      "not available (factory/arch is not built",
    );
    expect(
      summarizeArchCheck(ready, { exitCode: 0, stdout: "[]\n", stderr: "" }).join("\n"),
    ).toContain("no strict violations in touched files");
    const red = summarizeArchCheck(ready, {
      exitCode: 1,
      stdout: `${JSON.stringify([diagnostic])}\n`,
      stderr: "",
    });
    expect(red[0]).toContain("1 strict violation(s) in touched files");
    expect(red[1]).toBe(
      "  G8  packages/core/src/authoring/x.ts:12  Reach-in at contracts/owner/private.ts." +
        "  Fix: Import the owner's front door, not a private sibling.",
    );
    // A diagnostic without a fix recipe degrades to the bare line, never a throw.
    const noFix = {
      rule: "G8",
      file: "packages/core/src/authoring/x.ts",
      line: 12,
      message: "Reach-in at contracts/owner/private.ts.",
    };
    expect(
      summarizeArchCheck(ready, { exitCode: 1, stdout: JSON.stringify([noFix]), stderr: "" })[1],
    ).toBe("  G8  packages/core/src/authoring/x.ts:12  Reach-in at contracts/owner/private.ts.");
    // An empty fix recipe is treated as absent, not as a trailing `Fix: `.
    expect(
      summarizeArchCheck(ready, {
        exitCode: 1,
        stdout: JSON.stringify([{ ...noFix, fix: "" }]),
        stderr: "",
      })[1],
    ).toBe("  G8  packages/core/src/authoring/x.ts:12  Reach-in at contracts/owner/private.ts.");
    expect(red.at(-1)).toContain("reporting only");
    expect(
      summarizeArchCheck(ready, { exitCode: 2, stdout: "not json\n", stderr: "" }).join("\n"),
    ).toContain("no readable report (not json)");
    expect(summarizeArchCheck(ready, { error: "spawn ENOENT" }).join("\n")).toContain(
      "not available (spawn ENOENT)",
    );
  });

  it("reports arch violations from the built CLI without changing doctor's exit code", async ({
    task,
  }) => {
    const cwd = resolve(tmpDir(task, "arch-reports"));
    await writeJson(join(cwd, "factory", "arch", "package.json"), { name: "x" });
    await writeJson(join(cwd, "factory", "arch", "dist", "cli.js"), { name: "x" });
    await writeFile(
      join(cwd, "factory", "arch", "dist", "cli.js"),
      `process.stdout.write(JSON.stringify([{ rule: "G8", file: "packages/core/src/a.ts", line: 3, message: "Reach-in.", fix: "Import the front door." }]));\nprocess.exitCode = 1;\n`,
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["doctor"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("arch:check --changed: 1 strict violation(s)");
    expect(lines.join("\n")).toContain("G8  packages/core/src/a.ts:3  Reach-in.");
    expect(lines.join("\n")).toContain("Fix: Import the front door.");
    expect(lines.at(-1)).toBe("No TrailStep deprecation findings.");
    expect(errors).toEqual([]);
  });

  it("says so when the factory is present but unbuilt, and stays silent for user projects", async ({
    task,
  }) => {
    const unbuilt = tmpDir(task, "arch-unbuilt-doctor");
    await writeJson(join(unbuilt, "factory", "arch", "package.json"), { name: "x" });
    const unbuiltLines: string[] = [];
    expect(
      await main({
        argv: ["doctor"],
        cwd: unbuilt,
        io: { writeLine: (line) => unbuiltLines.push(line), writeError: () => {} },
      }),
    ).toBe(0);
    expect(unbuiltLines.join("\n")).toContain("not available (factory/arch is not built");

    const userProject = tmpDir(task, "arch-user-project");
    await mkdir(userProject, { recursive: true });
    const userLines: string[] = [];
    expect(
      await main({
        argv: ["doctor"],
        cwd: userProject,
        io: { writeLine: (line) => userLines.push(line), writeError: () => {} },
      }),
    ).toBe(0);
    expect(userLines).toEqual(["No TrailStep deprecation findings."]);
  });
});
