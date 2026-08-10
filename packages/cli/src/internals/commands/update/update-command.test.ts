import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

describe("updateCommand", () => {
  it("blocks TrailStep self-updates on removed-symbol findings before package.json mutation", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        dependencies: { "@trailstep/core": "0.1.0", "@trailstep/authoring": "0.1.0" },
      }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { review: "@acme/trailstep-workflows" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/trailstep-workflows", version: "1.0.0", main: "index.mjs" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep } from '@trailstep/authoring';\nexport const review = {};\n",
      "utf8",
    );
    const originalPackageJson = await readFile(packageJsonPath, "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: latestTrailStepOne,
      deprecationManifest: [removedAuthoringSymbol],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("@trailstep/authoring/removedStep");
    expect(errors.join("\n")).toMatch(/blocking deprecation findings/i);
    expect(await readFile(packageJsonPath, "utf8")).toBe(originalPackageJson);
  });

  it("allows a blocked TrailStep self-update preflight with --force and prints a warning", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { "@trailstep/core": "0.1.0", "@trailstep/authoring": "0.1.0" },
      }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { review: "@acme/trailstep-workflows" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/trailstep-workflows", version: "1.0.0", main: "index.mjs" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep } from '@trailstep/authoring';\nexport const review = {};\n",
      "utf8",
    );
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["update", "--assume-yes", "--force"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      packageCommandRunner: latestTrailStepOne,
      deprecationManifest: [removedAuthoringSymbol],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toMatch(/Warning: --force/);
    expect(lines.join("\n")).toContain("Planned TrailStep package updates:");
  });

  it("allows warning-only findings and still prints them", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { "@trailstep/core": "0.1.0", "@trailstep/authoring": "0.1.0" },
      }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { review: "@acme/trailstep-workflows" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/trailstep-workflows", version: "1.0.0", main: "index.mjs" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { oldStep } from '@trailstep/authoring';\nexport const review = {};\n",
      "utf8",
    );
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["update", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      packageCommandRunner: latestTrailStepOne,
      deprecationManifest: [{ ...removedAuthoringSymbol, symbol: "oldStep", removedIn: undefined }],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("warning @trailstep/authoring/oldStep");
    expect(lines.join("\n")).toContain("Planned TrailStep package updates:");
  });

  it("includes directly registered workflow files in TrailStep self-update preflight scanning", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { "@trailstep/core": "0.1.0", "@trailstep/authoring": "0.1.0" },
      }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { review: "./workflows/review.mjs" } } }),
      "utf8",
    );
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "import { removedStep } from '@trailstep/authoring';\nexport const review = {};\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: latestTrailStepOne,
      deprecationManifest: [removedAuthoringSymbol],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("workflows/review.mjs");
    expect(lines.join("\n")).toContain("removedStep");
    expect(errors).toEqual([
      "Update blocked: blocking deprecation findings found. Re-run with --force to continue.",
    ]);
  });

  it("prints all findings before the blocking error line", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { "@trailstep/core": "0.1.0", "@trailstep/authoring": "0.1.0" },
      }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { review: "@acme/trailstep-workflows" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/trailstep-workflows", version: "1.0.0", main: "index.mjs" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep, removedWorkflow } from '@trailstep/authoring';\nexport const review = {};\n",
      "utf8",
    );
    const output: string[] = [];

    await main({
      argv: ["update", "--assume-yes"],
      cwd,
      io: {
        writeLine: (line) => output.push(`line:${line}`),
        writeError: (line) => output.push(`error:${line}`),
      },
      packageCommandRunner: latestTrailStepOne,
      deprecationManifest: [
        removedAuthoringSymbol,
        { ...removedAuthoringSymbol, symbol: "removedWorkflow" },
      ],
    });

    const rendered = output.join("\n");
    expect(rendered.indexOf("removedStep")).toBeLessThan(rendered.indexOf("blocking deprecation"));
    expect(rendered.indexOf("removedWorkflow")).toBeLessThan(
      rendered.indexOf("blocking deprecation"),
    );
  });

  it("returns a no-op result without running workflow fallback", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "consumer" }), "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toMatch(/no changes needed/i);
    expect(errors).toEqual([]);
  });

  it("prints planned TrailStep self-update package changes without writing files", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        dependencies: {
          "@trailstep/core": "^0.0.1",
          "@trailstep/authoring": "^0.0.1",
          "@trailstep/cli": "^0.0.1",
        },
      }),
      "utf8",
    );
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: { text: async () => "", select: async () => "", confirm: async () => false },
      packageCommandRunner: async (request) => {
        const metadata: Record<string, unknown> = {
          "@trailstep/core": [{ version: "1.0.0" }],
          "@trailstep/authoring": [
            { version: "1.0.0", peerDependencies: { "@trailstep/core": "^1.0.0" } },
          ],
          "@trailstep/cli": [
            { version: "1.0.0", peerDependencies: { "@trailstep/core": "^1.0.0" } },
          ],
        };
        const packageName = String(request.args[1]).replace(/@\*$/u, "");
        return { exitCode: 0, stdout: JSON.stringify(metadata[packageName]) };
      },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("@trailstep/core: ^0.0.1 -> 1.0.0");
    expect(
      await import("node:fs/promises").then((fs) => fs.readFile(join(cwd, "package.json"), "utf8")),
    ).toContain("^0.0.1");
  });

  it("prints workflow package update targets and local-file skips without writing files", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "@acme/workflows": "^1.0.0" } }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({
        workflows: {
          project: {
            review: "./workflows/review.mjs",
            release: "@acme/workflows#release",
          },
        },
      }),
      "utf8",
    );
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["update", "--workflows", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      packageCommandRunner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify([{ version: "1.1.0" }]),
      }),
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain(
      "Skipped project/review: local file source, no version to update.",
    );
    expect(lines.join("\n")).toContain("@acme/workflows");
    expect(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(cwd, ".trailstep", "config.json"), "utf8"),
      ),
    ).toContain("@acme/workflows#release");
  });

  it("blocks updating a registered bundle workflow when another workflow in the bundle has a blocking finding", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "node_modules", "@trailstep", "authoring"), { recursive: true });
    await mkdir(join(packageDir, "dist"), { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        dependencies: {
          "@trailstep/authoring": "1.0.0",
          "@acme/workflows": "^1.0.0",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { release: "@acme/workflows#release" } } }),
      "utf8",
    );
    await writeFile(
      join(cwd, "node_modules", "@trailstep", "authoring", "package.json"),
      JSON.stringify({ name: "@trailstep/authoring", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "@acme/workflows",
        version: "1.0.0",
        trailstep: {
          workflows: {
            release: "./dist/release.mjs#releaseWorkflow",
            cleanup: "./dist/cleanup.mjs#cleanupWorkflow",
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "dist", "release.mjs"),
      "export const release = {};\n",
      "utf8",
    );
    await writeFile(
      join(packageDir, "dist", "cleanup.mjs"),
      "import { removedStep } from '@trailstep/authoring';\nexport const cleanup = {};\n",
      "utf8",
    );
    const originalPackageJson = await readFile(packageJsonPath, "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    const blockedExitCode = await main({
      argv: ["update", "--workflow=project/release", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: latestWorkflowPackage,
      deprecationManifest: [removedAuthoringSymbol],
    });

    expect(blockedExitCode).toBe(1);
    expect(lines.join("\n")).toContain("dist/cleanup.mjs");
    expect(lines.join("\n")).toContain("@trailstep/authoring/removedStep");
    expect(errors.join("\n")).toMatch(/blocking deprecation findings/i);
    expect(await readFile(packageJsonPath, "utf8")).toBe(originalPackageJson);

    const forceLines: string[] = [];
    const forceExitCode = await main({
      argv: ["update", "--workflow=project/release", "--assume-yes", "--force"],
      cwd,
      io: { writeLine: (line) => forceLines.push(line), writeError: () => undefined },
      packageCommandRunner: latestWorkflowPackage,
      deprecationManifest: [removedAuthoringSymbol],
    });

    expect(forceExitCode).toBe(0);
    expect(forceLines.join("\n")).toMatch(/Warning: --force/);
    expect(forceLines.join("\n")).toContain("Planned workflow package updates:");
  });

  it("uses target TrailStep versions during self-update preflight", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, "node_modules", "@trailstep", "authoring"), { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { "@trailstep/core": "0.1.0", "@trailstep/authoring": "0.1.0" },
      }),
      "utf8",
    );
    await writeFile(
      join(cwd, "node_modules", "@trailstep", "authoring", "package.json"),
      JSON.stringify({ name: "@trailstep/authoring", version: "0.1.0" }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { review: "@acme/trailstep-workflows" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/trailstep-workflows", version: "1.0.0", main: "index.mjs" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { futureRemoval } from '@trailstep/authoring';\nexport const review = {};\n",
      "utf8",
    );
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update", "--assume-yes"],
      cwd,
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      packageCommandRunner: latestTrailStepTwo,
      deprecationManifest: [
        {
          ...removedAuthoringSymbol,
          symbol: "futureRemoval",
          deprecatedSince: "1.5.0",
          removedIn: "2.0.0",
        },
      ],
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/blocking deprecation findings/i);
  });

  it("uses target TrailStep versions for workflow package preflight during --all", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "node_modules", "@trailstep", "authoring"), { recursive: true });
    await mkdir(join(packageDir, "dist"), { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        dependencies: {
          "@trailstep/core": "1.0.0",
          "@trailstep/authoring": "1.0.0",
          "@acme/workflows": "1.0.0",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(cwd, "node_modules", "@trailstep", "authoring", "package.json"),
      JSON.stringify({ name: "@trailstep/authoring", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { release: "@acme/workflows#release" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "@acme/workflows",
        version: "1.0.0",
        trailstep: {
          workflows: {
            release: "./dist/release.mjs#releaseWorkflow",
            cleanup: "./dist/cleanup.mjs#cleanupWorkflow",
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "dist", "release.mjs"),
      "export const release = {};\n",
      "utf8",
    );
    await writeFile(
      join(packageDir, "dist", "cleanup.mjs"),
      "import { futureRemoval } from '@trailstep/authoring';\nexport const cleanup = {};\n",
      "utf8",
    );
    const originalPackageJson = await readFile(packageJsonPath, "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update", "--all", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: latestTrailStepTwoAndWorkflowPackage,
      deprecationManifest: [
        {
          ...removedAuthoringSymbol,
          symbol: "futureRemoval",
          deprecatedSince: "1.5.0",
          removedIn: "2.0.0",
        },
      ],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("dist/cleanup.mjs");
    expect(errors.join("\n")).toMatch(/blocking deprecation findings/i);
    expect(await readFile(packageJsonPath, "utf8")).toBe(originalPackageJson);
  });

  it("applies self and workflow package updates together for --all --assume-yes", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(
        {
          dependencies: {
            "@trailstep/core": "^1.0.0",
            "@trailstep/authoring": "~1.0.0",
            "@acme/workflows": "^1.0.0",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { release: "@acme/workflows#release" } } }),
      "utf8",
    );
    const lines: string[] = [];
    const installRequests: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

    const exitCode = await main({
      argv: ["update", "--all", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          installRequests.push(request);
          return { exitCode: 0 };
        }
        return latestTrailStepTwoAndWorkflowPackage(request);
      },
    });

    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("Planned TrailStep package updates:");
    expect(lines.join("\n")).toContain("Planned workflow package updates:");
    expect(packageJson.dependencies["@trailstep/core"]).toBe("^2.0.0");
    expect(packageJson.dependencies["@trailstep/authoring"]).toBe("~2.0.0");
    expect(packageJson.dependencies["@acme/workflows"]).toBe("^1.1.0");
    expect(installRequests).toEqual([{ command: "pnpm", args: ["install"], cwd }]);
  });

  it("applies workflow package updates with --workflows even when there are no self updates", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify({ dependencies: { "@acme/workflows": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { release: "@acme/workflows#release" } } }),
      "utf8",
    );

    const exitCode = await main({
      argv: ["update", "--workflows", "--assume-yes"],
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          return { exitCode: 0 };
        }
        return latestWorkflowPackage(request);
      },
    });

    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(exitCode).toBe(0);
    expect(packageJson.dependencies["@acme/workflows"]).toBe("^1.1.0");
  });

  it("prints default npm warning before running install when no package manager is detected", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify({ dependencies: { "@trailstep/core": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    const events: string[] = [];

    const exitCode = await main({
      argv: ["update", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => events.push(`line:${line}`), writeError: () => undefined },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          events.push("install");
          return { exitCode: 0 };
        }
        return latestTrailStepTwo(request);
      },
    });

    expect(exitCode).toBe(0);
    expect(events).toContain("line:No lockfile or packageManager field found; defaulting to npm.");
    expect(
      events.indexOf("line:No lockfile or packageManager field found; defaulting to npm."),
    ).toBeLessThan(events.indexOf("install"));
  });

  it("applies self update with --assume-yes, prints version changes, and runs detected install", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify(
        { dependencies: { "@trailstep/core": "^1.0.0", "@trailstep/authoring": "~1.0.0" } },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const lines: string[] = [];
    const installRequests: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

    const exitCode = await main({
      argv: ["update", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          installRequests.push(request);
          return { exitCode: 0, stdout: "installed" };
        }
        return latestTrailStepTwo(request);
      },
    });

    const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("@trailstep/core: ^1.0.0 -> 2.0.0");
    expect(packageJson.dependencies["@trailstep/core"]).toBe("^2.0.0");
    expect(packageJson.dependencies["@trailstep/authoring"]).toBe("~2.0.0");
    expect(installRequests).toEqual([{ command: "pnpm", args: ["install"], cwd }]);
  });

  it("prints direct-file skip lines before prompting for confirmation", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify({ dependencies: { "@trailstep/core": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(cwd, ".trailstep", "config.json"),
      JSON.stringify({ workflows: { project: { review: "./workflows/review.mjs" } } }),
      "utf8",
    );
    const events: string[] = [];

    const exitCode = await main({
      argv: ["update", "--all"],
      cwd,
      io: { writeLine: (line) => events.push(`line:${line}`), writeError: () => undefined },
      prompts: {
        text: async () => "",
        select: async () => "",
        confirm: async () => {
          events.push("prompt:confirm");
          return true;
        },
      },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          return { exitCode: 0 };
        }
        return latestTrailStepTwo(request);
      },
    });

    expect(exitCode).toBe(0);
    expect(events.findIndex((event) => event.includes("Skipped project/review"))).toBeLessThan(
      events.indexOf("prompt:confirm"),
    );
  });

  it("fails before writing when confirmation is required but no confirm prompt seam exists", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify({ dependencies: { "@trailstep/core": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    const original = await readFile(packageJsonPath, "utf8");
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      prompts: { text: async () => "", select: async () => "" },
      packageCommandRunner: latestTrailStepTwo,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/--assume-yes or an interactive confirm prompt/i);
    expect(await readFile(packageJsonPath, "utf8")).toBe(original);
  });

  it("exits cleanly without writing or installing when confirmation is declined", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify({ dependencies: { "@trailstep/core": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    const original = await readFile(packageJsonPath, "utf8");
    const installRequests: unknown[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: { text: async () => "", select: async () => "", confirm: async () => false },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          installRequests.push(request);
          return { exitCode: 0 };
        }
        return latestTrailStepTwo(request);
      },
    });

    expect(exitCode).toBe(0);
    expect(await readFile(packageJsonPath, "utf8")).toBe(original);
    expect(installRequests).toEqual([]);
  });

  it("reports failed installs without claiming success", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify({ dependencies: { "@trailstep/core": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update", "--assume-yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          return { exitCode: 7, stderr: "lockfile conflict" };
        }
        return latestTrailStepTwo(request);
      },
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Install failed with exit code 7");
    expect(errors.join("\n")).toContain("lockfile conflict");
    expect(lines.join("\n")).not.toMatch(/update complete/i);
  });

  it("reports registry resolution failures as CLI errors", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "@trailstep/core": "^0.0.1" } }),
      "utf8",
    );
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      packageCommandRunner: async () => ({ exitCode: 0, stdout: "not json" }),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/Malformed npm view JSON for @trailstep\/core/);
  });
});

const removedAuthoringSymbol = {
  packageName: "@trailstep/authoring",
  symbol: "removedStep",
  deprecatedSince: "0.5.0",
  removedIn: "1.0.0",
  message: "removedStep was removed.",
  replacement: "step",
};

async function latestWorkflowPackage(request: { readonly args: readonly string[] }) {
  const packageName = String(request.args[1]).replace(/@\*$/u, "");
  if (packageName === "@acme/workflows") {
    return { exitCode: 0, stdout: JSON.stringify([{ version: "1.0.0" }, { version: "1.1.0" }]) };
  }
  return latestTrailStepOne(request);
}

async function latestTrailStepTwo(request: { readonly args: readonly string[] }) {
  const metadata: Record<string, unknown> = {
    "@trailstep/core": [{ version: "2.0.0" }],
    "@trailstep/authoring": [
      { version: "2.0.0", peerDependencies: { "@trailstep/core": "^2.0.0" } },
    ],
    "@trailstep/cli": [{ version: "2.0.0", peerDependencies: { "@trailstep/core": "^2.0.0" } }],
  };
  const packageName = String(request.args[1]).replace(/@\*$/u, "");
  return { exitCode: 0, stdout: JSON.stringify(metadata[packageName]) };
}

async function latestTrailStepTwoAndWorkflowPackage(request: { readonly args: readonly string[] }) {
  const packageName = String(request.args[1]).replace(/@\*$/u, "");
  if (packageName === "@acme/workflows") {
    return { exitCode: 0, stdout: JSON.stringify([{ version: "1.0.0" }, { version: "1.1.0" }]) };
  }
  return latestTrailStepTwo(request);
}

async function latestTrailStepOne(request: { readonly args: readonly string[] }) {
  const metadata: Record<string, unknown> = {
    "@trailstep/core": [{ version: "1.0.0" }],
    "@trailstep/authoring": [
      { version: "1.0.0", peerDependencies: { "@trailstep/core": "^1.0.0" } },
    ],
    "@trailstep/cli": [{ version: "1.0.0", peerDependencies: { "@trailstep/core": "^1.0.0" } }],
  };
  const packageName = String(request.args[1]).replace(/@\*$/u, "");
  return { exitCode: 0, stdout: JSON.stringify(metadata[packageName]) };
}
